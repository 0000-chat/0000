import type { Handler } from "hono";
import {
  IngestionAcceptedResponseSchema,
  IngestionCommittedArchiveManifestSchema,
  MAX_INGESTION_REQUEST_BYTES,
  type CommittedArchivePointer,
} from "@communicator/contracts";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  resolveActiveIngestionRoute,
  resolveActiveIngressBindings,
} from "../control-directory/ingestion-repository";
import {
  archiveCanonicalEventBatch,
  type ArchiveCanonicalEventBatchResult,
} from "../archive/writer";
import {
  buildCommittedArchivePointer,
  mapArchiveFailure,
  prepareIngestionBatch,
} from "./prepare";
import {
  ingestionError,
  ingestionErrorResponse,
  isIngestionError,
  type IngestionError,
} from "./errors";

const INGESTION_BATCH_PATH = "/internal/v1/ingestion/batches";

export type IngestionQueueSendOptions = {
  contentType: "json";
};

/**
 * Narrow seam for route tests. Production callers use the binding directly;
 * tests can capture the exact pointer without replacing archive or D1 work.
 */
export type IngestionQueueSender = (
  pointer: CommittedArchivePointer,
  options: IngestionQueueSendOptions,
) => Promise<void>;

export type IngestionRouteServices = {
  sendIngestionQueue?: IngestionQueueSender;
};

type IngestionHandlerEnv = {
  Bindings: Cloudflare.Env;
  Variables: IngestionAuthorizationVariables;
};

type IngestionRequestContext = Parameters<
  Handler<IngestionHandlerEnv>
>[0];

const statusFor = (error: IngestionError): 400 | 401 | 404 | 409 | 413 | 503 => {
  switch (error.code) {
    case "ingestion_invalid":
      return 400;
    case "ingestion_too_large":
      return 413;
    case "ingestion_unauthenticated":
      return 401;
    case "ingestion_not_found":
      return 404;
    case "ingestion_conflict":
      return 409;
    case "ingestion_unavailable":
      return 503;
  }
};

const respondWithError = (
  context: IngestionRequestContext,
  error: IngestionError,
) => context.json(ingestionErrorResponse(error), statusFor(error));

const contentTypeIsJson = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  return /^[\t ]*application\/json[\t ]*(?:;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(
    value,
  );
};

const contentEncodingIsIdentity = (value: string | undefined): boolean =>
  value === undefined || value.trim().toLowerCase() === "identity";

const declaredLength = (request: Request): number | undefined => {
  const value = request.headers.get("Content-Length");
  if (value === null) return undefined;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw ingestionError("ingestion_invalid");
  const length = Number(normalized);
  if (!Number.isSafeInteger(length) || length > MAX_INGESTION_REQUEST_BYTES) {
    throw ingestionError("ingestion_too_large");
  }
  return length;
};

/**
 * Read at most the exact transport ceiling, cancelling the body as soon as a
 * chunk would cross it. The semantic archive limits are enforced later by
 * prepareIngestionBatch.
 */
export const readBoundedRequestBody = async (
  request: Request,
): Promise<Uint8Array> => {
  if (!contentTypeIsJson(request.headers.get("Content-Type") ?? undefined)) {
    throw ingestionError("ingestion_invalid");
  }
  if (!contentEncodingIsIdentity(request.headers.get("Content-Encoding") ?? undefined)) {
    throw ingestionError("ingestion_invalid");
  }

  let contentLength: number | undefined;
  try {
    contentLength = declaredLength(request);
  } catch (error) {
    if (
      isIngestionError(error) &&
      error.code === "ingestion_too_large" &&
      request.body !== null
    ) {
      try {
        await request.body.cancel();
      } catch {
        // The body may already be closed; the bounded rejection is unchanged.
      }
    }
    throw error;
  }
  if (request.body === null) throw ingestionError("ingestion_invalid");

  const reader = request.body.getReader();
  let body = new Uint8Array(contentLength ?? 0);
  let total = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw ingestionError("ingestion_unavailable", error);
      }
      if (result.done) break;

      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        throw ingestionError("ingestion_invalid");
      }
      if (chunk.byteLength > MAX_INGESTION_REQUEST_BYTES - total) {
        try {
          await reader.cancel();
        } catch {
          // The request is already rejected; cancellation is best effort.
        }
        throw ingestionError("ingestion_too_large");
      }

      const required = total + chunk.byteLength;
      if (required > body.byteLength) {
        const nextCapacity = Math.min(
          MAX_INGESTION_REQUEST_BYTES,
          Math.max(required, body.byteLength === 0 ? 64 * 1024 : body.byteLength * 2),
        );
        const nextBody = new Uint8Array(nextCapacity);
        nextBody.set(body.subarray(0, total));
        body = nextBody;
      }
      body.set(chunk, total);
      total = required;
    }
  } finally {
    reader.releaseLock();
  }

  if (total === body.byteLength) return body;
  const exactBody = new Uint8Array(total);
  exactBody.set(body.subarray(0, total));
  return exactBody;
};

const parseUtf8Json = (bytes: Uint8Array): unknown => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw ingestionError("ingestion_invalid", error);
  }
};

const parseRequestBody = async (request: Request): Promise<unknown> =>
  parseUtf8Json(await readBoundedRequestBody(request));

const manifestMatchesPreparation = (
  result: ArchiveCanonicalEventBatchResult,
  prepared: Awaited<ReturnType<typeof prepareIngestionBatch>>,
) => {
  const parsed = IngestionCommittedArchiveManifestSchema.safeParse(result.manifest);
  if (!parsed.success) throw ingestionError("ingestion_conflict", parsed.error);
  const manifest = parsed.data;

  if (
    manifest.tenant_id !== prepared.tenantId ||
    manifest.batch_id !== prepared.batchId ||
    manifest.canonical_sha256 !== prepared.canonicalSha256 ||
    manifest.archived_at !== prepared.archivedAt ||
    manifest.producer.version !== prepared.producerVersion ||
    manifest.event_count !== prepared.events.length ||
    manifest.source_checkpoint.kind !== prepared.sourceCheckpoint.kind ||
    manifest.source_checkpoint.value !== prepared.sourceCheckpoint.value
  ) {
    throw ingestionError("ingestion_conflict");
  }

  return manifest;
};

const validateTrustedBindings = (
  events: readonly {
    account_id: string;
    identity_id: string;
    platform: string;
  }[],
  bindings: Awaited<ReturnType<typeof resolveActiveIngressBindings>>,
  gatewayRouteId: string,
): void => {
  if (!bindings.ok) {
    throw ingestionError(
      bindings.code === "not_found"
        ? "ingestion_not_found"
        : "ingestion_unavailable",
    );
  }

  const byAccount = new Map(
    bindings.value.map((binding) => [binding.account_id, binding]),
  );
  for (const event of events) {
    const binding = byAccount.get(event.account_id);
    if (
      binding === undefined ||
      binding.gateway_route_id !== gatewayRouteId ||
      binding.identity_id !== event.identity_id ||
      binding.platform !== event.platform
    ) {
      throw ingestionError("ingestion_not_found");
    }
  }
};

const sendPointer = async (
  context: IngestionRequestContext,
  services: IngestionRouteServices,
  pointer: CommittedArchivePointer,
): Promise<void> => {
  const options: IngestionQueueSendOptions = { contentType: "json" };
  if (services.sendIngestionQueue !== undefined) {
    await services.sendIngestionQueue(pointer, options);
    return;
  }

  const queue = context.env.INGESTION_QUEUE;
  if (queue === undefined || typeof queue.send !== "function") {
    throw ingestionError("ingestion_unavailable");
  }
  await queue.send(pointer, options);
};

export const createIngestionBatchHandler = (
  services: IngestionRouteServices = {},
): Handler<IngestionHandlerEnv> => async (context) => {
  let prepared: Awaited<ReturnType<typeof prepareIngestionBatch>>;
  try {
    const input = await parseRequestBody(context.req.raw);
    prepared = await prepareIngestionBatch(input);
  } catch (error) {
    const mapped = isIngestionError(error)
      ? error
      : ingestionError("ingestion_unavailable", error);
    return respondWithError(context, mapped);
  }

  let archiveResult: ArchiveCanonicalEventBatchResult;
  try {
    const authorization = context.get("ingestionAuthorization");
    const database = context.env.CONTROL_DB;
    if (database === undefined) throw ingestionError("ingestion_unavailable");

    const route = await resolveActiveIngestionRoute(
      database,
      authorization.service_principal_id,
      prepared.gatewayRouteId,
    );
    if (!route.ok) {
      throw ingestionError(
        route.code === "not_found"
          ? "ingestion_not_found"
          : "ingestion_unavailable",
      );
    }

    const accountIds = [...new Set(prepared.events.map((event) => event.account_id))];
    const bindings = await resolveActiveIngressBindings(
      database,
      route.value.gateway_route_id,
      prepared.tenantId,
      accountIds,
    );
    validateTrustedBindings(prepared.events, bindings, route.value.gateway_route_id);

    archiveResult = await archiveCanonicalEventBatch({
      bucket: context.env.EVENT_ARCHIVE,
      ...prepared.archiveInput,
    });
  } catch (error) {
    const mapped = isIngestionError(error)
      ? error
      : mapArchiveFailure(error);
    return respondWithError(context, mapped);
  }

  let pointer: CommittedArchivePointer;
  try {
    const manifest = manifestMatchesPreparation(archiveResult, prepared);
    pointer = buildCommittedArchivePointer({
      tenantId: manifest.tenant_id,
      batchId: manifest.batch_id,
      manifestKey: archiveResult.manifestKey,
      canonicalSha256: manifest.canonical_sha256,
      gatewayRouteId: prepared.gatewayRouteId,
    });
  } catch (error) {
    const mapped = isIngestionError(error)
      ? error
      : ingestionError("ingestion_conflict", error);
    return respondWithError(context, mapped);
  }

  try {
    await sendPointer(context, services, pointer);
  } catch (error) {
    return respondWithError(
      context,
      isIngestionError(error)
        ? error
        : ingestionError("ingestion_unavailable", error),
    );
  }

  const response = IngestionAcceptedResponseSchema.parse({
    schema_version: 1,
    tenant_id: prepared.tenantId,
    batch_id: prepared.batchId,
    status: "accepted",
    archive_status: archiveResult.status,
  });
  return context.json(response, 202);
};

export { INGESTION_BATCH_PATH };
