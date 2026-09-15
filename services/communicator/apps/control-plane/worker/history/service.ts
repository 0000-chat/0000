import {
  HistoryImportSchema,
  ProviderCapabilitySchema,
  ProjectionAuthorizationContextSchema,
  ProjectionConnectionBindingSchema,
  type HistoryImport,
  type HistoryImportDetail,
  type HistoryImportRange,
  type ProviderCapability,
  type ProjectionEventEnvelope,
} from "@communicator/contracts";
import { canonicalJsonStringify } from "../archive/canonical-json";
import { sha256Hex } from "../archive/codec";
import { getTenantProjection } from "../projection/routing";
import {
  createImport,
  claimHistoryRangeWork,
  closeHistoryRangeWork,
  ensureHistoryRangeWork,
  findHistoryAccount,
  findHistoryProjectionBinding,
  findImportByIdempotency,
  getDetail,
  getImport,
  getRanges,
  insertEventHashes,
  insertRanges,
  listExistingEventHashes,
  scheduleHistoryRangeWork,
  updateImport,
  updateRange,
  upsertCapability,
  type HistoryImportCreateInput,
  type HistoryRepositoryErrorCode,
} from "./repository";
import {
  HistoryProviderError,
  type HistoryImportProvider,
  type HistoryImportProviderOwner,
  type HistoryProviderAdvanceResult,
  type HistoryProviderRange,
  type HistoryProviderStartResult,
} from "./provider";

const MAX_PROVIDER_RANGES = 100;
const MAX_PROVIDER_EVENTS_PER_PAGE = 500;
const HISTORY_RETRY_BASE_MS = 60_000;
const HISTORY_RETRY_MAX_MS = 15 * 60_000;

export type HistoryServiceEnvironment = Pick<
  Cloudflare.Env,
  "CONTROL_DB" | "TENANT_PROJECTION"
>;

export type HistoryService = {
  start(input: {
    env: HistoryServiceEnvironment;
    tenantId: string;
    accountId: string;
    identityId: string;
    idempotencyKey: string;
    startAt: string;
    endAt: string;
    maxEvents: number;
  }): Promise<HistoryImportDetail>;
  advance(input: {
    env: HistoryServiceEnvironment;
    tenantId: string;
    importId: string;
    accountId: string;
    identityId: string;
    rangeId?: string;
    leaseToken?: string;
    leaseUntil?: string;
  }): Promise<HistoryImportDetail>;
};

export type HistoryServiceDependencies = {
  provider: HistoryImportProvider;
  now?: () => Date;
  applyEvents?: (input: {
    env: HistoryServiceEnvironment;
    tenantId: string;
    accountId: string;
    identityId: string;
    importId: string;
    rangeId: string;
    events: readonly ProjectionEventEnvelope[];
  }) => Promise<void>;
};

class HistoryServiceError extends Error {
  constructor(
    readonly code:
      | HistoryRepositoryErrorCode
      | "history_provider_unavailable"
      | "history_provider_error"
      | "history_provider_timeout",
    cause?: unknown,
  ) {
    super(code);
    this.name = "HistoryServiceError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export { HistoryServiceError };

const nowIso = (clock: () => Date): string => {
  const value = clock().toISOString();
  if (!Number.isFinite(Date.parse(value)))
    throw new HistoryServiceError("history_invalid");
  return value;
};

const id = (prefix: "import" | "range"): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const providerOwner = (
  input: Pick<
    HistoryImport,
    | "tenant_id"
    | "account_id"
    | "connection_id"
    | "identity_id"
    | "provider"
    | "import_id"
    | "requested_start_at"
    | "requested_end_at"
    | "max_events"
  >,
): HistoryImportProviderOwner => ({
  tenant_id: input.tenant_id,
  account_id: input.account_id,
  connection_id: input.connection_id,
  identity_id: input.identity_id,
  provider: input.provider,
  import_id: input.import_id,
  start_at: input.requested_start_at,
  end_at: input.requested_end_at,
  max_events: input.max_events,
});

const providerFailure = (error: unknown): HistoryServiceError => {
  if (error instanceof HistoryServiceError) return error;
  if (error instanceof HistoryProviderError) {
    return new HistoryServiceError(
      error.code === "runtime_unavailable"
        ? "history_provider_unavailable"
        : error.code === "provider_timeout"
          ? "history_provider_timeout"
          : "history_provider_error",
      error,
    );
  }
  return new HistoryServiceError("history_provider_error", error);
};

const providerErrorCode = (
  error: HistoryServiceError,
): HistoryImport["last_error_code"] => {
  switch (error.code) {
    case "history_provider_unavailable":
      return "runtime_unavailable";
    case "history_provider_timeout":
      return "provider_timeout";
    case "history_provider_error":
      return "provider_error";
    default:
      return "provider_error";
  }
};

const validateRange = (
  range: HistoryProviderRange,
  requestedStart: string,
  requestedEnd: string,
): void => {
  if (
    !Number.isFinite(Date.parse(range.start_at)) ||
    !Number.isFinite(Date.parse(range.end_at)) ||
    Date.parse(range.start_at) >= Date.parse(range.end_at) ||
    Date.parse(range.start_at) < Date.parse(requestedStart) ||
    Date.parse(range.end_at) > Date.parse(requestedEnd)
  ) {
    throw new HistoryServiceError("history_invalid");
  }
  if (
    range.source_cursor !== null &&
    (range.source_cursor.length === 0 || range.source_cursor.length > 2_048)
  ) {
    throw new HistoryServiceError("history_invalid");
  }
};

const validateRanges = (
  ranges: readonly HistoryProviderRange[],
  requestedStart: string,
  requestedEnd: string,
): void => {
  if (ranges.length > MAX_PROVIDER_RANGES) {
    throw new HistoryServiceError("history_invalid");
  }
  const sorted = [...ranges].sort((left, right) =>
    left.start_at.localeCompare(right.start_at),
  );
  let previousEnd: string | undefined;
  for (const range of sorted) {
    validateRange(range, requestedStart, requestedEnd);
    if (previousEnd !== undefined && range.start_at < previousEnd) {
      throw new HistoryServiceError("history_invalid");
    }
    previousEnd = range.end_at;
  }
};

const capabilityFromStart = (
  item: HistoryImport,
  result: HistoryProviderStartResult,
  updatedAt: string,
): ProviderCapability => {
  const status =
    result.availability === "available" ? "conditional" : "unverified";
  return ProviderCapabilitySchema.parse({
    tenant_id: item.tenant_id,
    account_id: item.account_id,
    connection_id: item.connection_id,
    identity_id: item.identity_id,
    provider: item.provider,
    capability: "history.import",
    status,
    freshness: result.availability === "available" ? "fresh" : "unavailable",
    provider_version: result.provider_version,
    proof_source: result.proof_source,
    provider_evidence: result.provider_evidence,
    product_claim:
      result.availability === "available"
        ? "The configured private adapter accepted a bounded history request; live provider proof remains conditional."
        : "History import is not available from the configured runtime for this account.",
    observed_at: result.provider_evidence.observed_at,
    updated_at: updatedAt,
  });
};

const applyDefaultProjectionEvents = async (input: {
  env: HistoryServiceEnvironment;
  tenantId: string;
  accountId: string;
  identityId: string;
  importId: string;
  rangeId: string;
  events: readonly ProjectionEventEnvelope[];
}): Promise<void> => {
  if (input.events.length === 0) return;
  const binding = await findHistoryProjectionBinding(
    input.env.CONTROL_DB,
    input.tenantId,
    input.accountId,
  );
  if (
    binding.identity_id !== input.identityId ||
    binding.account_id !== input.accountId
  ) {
    throw new HistoryServiceError("history_conflict");
  }
  for (const event of input.events) {
    if (
      event.tenant_id !== input.tenantId ||
      event.account_id !== input.accountId ||
      event.identity_id !== input.identityId ||
      event.platform !== binding.provider ||
      event.event_source !== "backfill"
    ) {
      throw new HistoryServiceError("history_conflict");
    }
  }
  const projection = getTenantProjection(input.env, input.tenantId);
  const initializeAuthorization = ProjectionAuthorizationContextSchema.parse({
    schema_version: 1,
    tenant_id: input.tenantId,
    principal_id: binding.service_principal_id,
    allowed_identity_ids: [input.identityId],
    scopes: ["projection.initialize"],
  });
  await projection.initialize({
    schema_version: 1,
    tenant_id: input.tenantId,
    initialized_at: eventObservedAt(input.events),
    authorization: initializeAuthorization,
  });
  const writeAuthorization = ProjectionAuthorizationContextSchema.parse({
    schema_version: 1,
    tenant_id: input.tenantId,
    principal_id: binding.service_principal_id,
    allowed_identity_ids: [input.identityId],
    scopes: ["projection.write"],
  });
  const connection = ProjectionConnectionBindingSchema.parse({
    account_id: input.accountId,
    connection_id: binding.connection_id,
    identity_id: input.identityId,
    platform: binding.provider,
  });
  const last = [...input.events]
    .sort((left, right) =>
      left.observed_at === right.observed_at
        ? left.event_id.localeCompare(right.event_id)
        : left.observed_at.localeCompare(right.observed_at),
    )
    .at(-1);
  if (last === undefined) return;
  await projection.applyBatch({
    schema_version: 1,
    tenant_id: input.tenantId,
    authorization: writeAuthorization,
    mode: "live",
    rebuild_id: null,
    connections: [connection],
    events: [...input.events],
    checkpoint: {
      kind: "history_import",
      value: `${input.importId}:${input.rangeId}`,
      last_observed_at: last.observed_at,
      last_event_id: last.event_id,
    },
  });
};

const eventObservedAt = (
  events: readonly ProjectionEventEnvelope[],
): string => {
  const first = events[0];
  if (first === undefined) throw new HistoryServiceError("history_invalid");
  return first.observed_at;
};

const validateEvents = (
  events: readonly ProjectionEventEnvelope[],
  item: HistoryImport,
): void => {
  if (events.length > MAX_PROVIDER_EVENTS_PER_PAGE)
    throw new HistoryServiceError("history_invalid");
  for (const event of events) {
    if (
      event.tenant_id !== item.tenant_id ||
      event.account_id !== item.account_id ||
      event.identity_id !== item.identity_id ||
      event.platform !== item.provider ||
      event.event_source !== "backfill"
    ) {
      throw new HistoryServiceError("history_conflict");
    }
  }
};

const hashEvent = async (event: ProjectionEventEnvelope): Promise<string> =>
  sha256Hex(new TextEncoder().encode(canonicalJsonStringify(event)));

const updateFailed = async (
  db: D1Database,
  item: HistoryImport,
  range: HistoryImportRange,
  errorCode: HistoryImport["last_error_code"],
  now: string,
  terminal: boolean,
  leaseToken?: string,
): Promise<void> => {
  const nextAttempts = Math.min(item.max_attempts, range.attempt_count + 1);
  const exhausted = terminal || nextAttempts >= item.max_attempts;
  await updateRange(db, {
    range_id: range.range_id,
    status: exhausted ? "failed" : "active",
    attempt_count: nextAttempts,
    error_code: errorCode,
    updated_at: now,
    completed_at: exhausted ? now : null,
    ...(leaseToken === undefined ? {} : { lease_token: leaseToken }),
  });
  const ranges = await getRanges(db, item.import_id);
  const completed = ranges.filter(
    (candidate) => candidate.status === "completed",
  ).length;
  const gaps = ranges.filter(
    (candidate) =>
      candidate.status === "gap" ||
      candidate.status === "partial" ||
      candidate.status === "failed",
  ).length;
  const hasPending = ranges.some(
    (candidate) =>
      candidate.status === "pending" || candidate.status === "active",
  );
  const importFailed = exhausted && !hasPending;
  await updateImport(db, {
    import_id: item.import_id,
    status: importFailed ? "failed" : "active",
    availability:
      errorCode === "runtime_unavailable" ? "unavailable" : "blocked",
    attempt_count: nextAttempts,
    last_error_code: exhausted
      ? nextAttempts >= item.max_attempts
        ? "bounded_retry_exhausted"
        : errorCode
      : errorCode,
    completed_range_count: completed,
    total_range_count: ranges.length,
    gap_count: gaps,
    updated_at: now,
    completed_at: importFailed ? now : null,
    ...(leaseToken === undefined
      ? {}
      : { lease_token: leaseToken, range_id: range.range_id }),
  });
};

const refreshDetail = async (
  env: HistoryServiceEnvironment,
  tenantId: string,
  importId: string,
  accountId: string,
): Promise<HistoryImportDetail> =>
  getDetail(env.CONTROL_DB, tenantId, importId, accountId);

const retryDelay = (attemptCount: number): number =>
  Math.min(
    HISTORY_RETRY_MAX_MS,
    HISTORY_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attemptCount - 1, 4)),
  );

const retryAt = (now: string, attemptCount: number): string => {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp))
    throw new HistoryServiceError("history_invalid");
  return new Date(timestamp + retryDelay(attemptCount)).toISOString();
};

/** Reconcile wake state only after the range checkpoint has been written. */
const reconcileHistoryWork = async (input: {
  env: HistoryServiceEnvironment;
  item: HistoryImport;
  ranges: readonly HistoryImportRange[];
  now: string;
  leaseToken?: string;
  currentRangeId?: string;
}): Promise<void> => {
  for (const range of input.ranges) {
    const currentLease =
      range.range_id === input.currentRangeId ? input.leaseToken : undefined;
    if (range.status === "active" || range.status === "pending") {
      if (input.currentRangeId === undefined || currentLease !== undefined) {
        await scheduleHistoryRangeWork(input.env.CONTROL_DB, {
          tenant_id: input.item.tenant_id,
          import_id: input.item.import_id,
          range_id: range.range_id,
          account_id: input.item.account_id,
          source_cursor: range.source_cursor,
          next_attempt_at:
            range.error_code === null
              ? input.now
              : retryAt(input.now, range.attempt_count),
          updated_at: input.now,
          ...(currentLease === undefined ? {} : { lease_token: currentLease }),
        });
      }
    } else {
      await closeHistoryRangeWork(input.env.CONTROL_DB, {
        import_id: input.item.import_id,
        range_id: range.range_id,
        account_id: input.item.account_id,
        updated_at: input.now,
        ...(currentLease === undefined ? {} : { lease_token: currentLease }),
      });
    }
    if (range.status === "active" || range.status === "pending") {
      await ensureHistoryRangeWork(input.env.CONTROL_DB, {
        import_id: input.item.import_id,
        range_id: range.range_id,
        account_id: input.item.account_id,
        source_cursor: range.source_cursor,
        next_attempt_at: input.now,
        updated_at: input.now,
      });
    }
  }
};

const createService = (
  dependencies: HistoryServiceDependencies,
): HistoryService => {
  const clock = dependencies.now ?? (() => new Date());
  const applyEvents = dependencies.applyEvents ?? applyDefaultProjectionEvents;

  const start = async (input: Parameters<HistoryService["start"]>[0]) => {
    const binding = await findHistoryAccount(
      input.env.CONTROL_DB,
      input.tenantId,
      input.accountId,
      input.identityId,
    );
    if (binding.status !== "active")
      throw new HistoryServiceError("history_conflict");
    const existing = await findImportByIdempotency(
      input.env.CONTROL_DB,
      input.tenantId,
      input.accountId,
      input.idempotencyKey,
    );
    if (existing !== null) {
      if (
        existing.identity_id !== input.identityId ||
        existing.requested_start_at !== input.startAt ||
        existing.requested_end_at !== input.endAt ||
        existing.max_events !== input.maxEvents
      ) {
        throw new HistoryServiceError("history_conflict");
      }
      return refreshDetail(
        input.env,
        input.tenantId,
        existing.import_id,
        input.accountId,
      );
    }
    const startedAt = nowIso(clock);
    const create: HistoryImportCreateInput = {
      import_id: id("import"),
      range_id: id("range"),
      tenant_id: input.tenantId,
      account_id: input.accountId,
      connection_id: binding.connection_id,
      identity_id: binding.identity_id,
      provider: binding.provider,
      idempotency_key: input.idempotencyKey,
      requested_start_at: input.startAt,
      requested_end_at: input.endAt,
      max_events: input.maxEvents,
      started_at: startedAt,
    };
    await createImport(input.env.CONTROL_DB, create);
    const item = await getImport(
      input.env.CONTROL_DB,
      input.tenantId,
      create.import_id,
      input.accountId,
    );
    let providerResult: HistoryProviderStartResult;
    try {
      providerResult = await dependencies.provider.start(providerOwner(item));
    } catch (error) {
      const failure = providerFailure(error);
      const errorCode = providerErrorCode(failure);
      const range = (await getRanges(input.env.CONTROL_DB, item.import_id))[0];
      if (range === undefined) throw new HistoryServiceError("history_invalid");
      await updateFailed(
        input.env.CONTROL_DB,
        item,
        range,
        errorCode,
        nowIso(clock),
        failure.code === "history_provider_error" ||
          failure.code === "history_provider_timeout",
      );
      const detail = await refreshDetail(
        input.env,
        input.tenantId,
        item.import_id,
        input.accountId,
      );
      await reconcileHistoryWork({
        env: input.env,
        item: detail.import,
        ranges: detail.ranges,
        now: nowIso(clock),
      });
      return detail;
    }
    try {
      validateRanges(
        providerResult.ranges,
        item.requested_start_at,
        item.requested_end_at,
      );
      const updated = nowIso(clock);
      await upsertCapability(
        input.env.CONTROL_DB,
        capabilityFromStart(item, providerResult, updated),
      );
      if (providerResult.availability !== "available") {
        const range = (
          await getRanges(input.env.CONTROL_DB, item.import_id)
        )[0];
        if (range === undefined)
          throw new HistoryServiceError("history_invalid");
        await updateFailed(
          input.env.CONTROL_DB,
          item,
          range,
          providerResult.error_code ??
            (providerResult.availability === "blocked"
              ? "provider_refused"
              : "runtime_unavailable"),
          updated,
          true,
        );
        const detail = await refreshDetail(
          input.env,
          input.tenantId,
          item.import_id,
          input.accountId,
        );
        await reconcileHistoryWork({
          env: input.env,
          item: detail.import,
          ranges: detail.ranges,
          now: updated,
        });
        return detail;
      }
      if (providerResult.ranges.length === 0) {
        const range = (
          await getRanges(input.env.CONTROL_DB, item.import_id)
        )[0];
        if (range === undefined)
          throw new HistoryServiceError("history_invalid");
        await updateRange(input.env.CONTROL_DB, {
          range_id: range.range_id,
          status: "completed",
          event_count: 0,
          updated_at: updated,
          completed_at: updated,
        });
        await updateImport(input.env.CONTROL_DB, {
          import_id: item.import_id,
          status: "completed",
          availability: "available",
          source_start_at: providerResult.source_start_at,
          source_end_at: providerResult.source_end_at,
          completed_range_count: 1,
          total_range_count: 1,
          updated_at: updated,
          completed_at: updated,
        });
        const detail = await refreshDetail(
          input.env,
          input.tenantId,
          item.import_id,
          input.accountId,
        );
        await reconcileHistoryWork({
          env: input.env,
          item: detail.import,
          ranges: detail.ranges,
          now: updated,
        });
        return detail;
      }
      const [first, ...rest] = providerResult.ranges;
      if (first === undefined) throw new HistoryServiceError("history_invalid");
      const oldRange = (
        await getRanges(input.env.CONTROL_DB, item.import_id)
      )[0];
      if (oldRange === undefined)
        throw new HistoryServiceError("history_invalid");
      await updateRange(input.env.CONTROL_DB, {
        range_id: oldRange.range_id,
        status: "active",
        source_cursor: first.source_cursor,
        updated_at: updated,
      });
      await insertRanges(
        input.env.CONTROL_DB,
        rest.map((range) => ({
          range_id: id("range"),
          import_id: item.import_id,
          account_id: item.account_id,
          start_at: range.start_at,
          end_at: range.end_at,
          source_cursor: range.source_cursor,
          created_at: updated,
        })),
      );
      await updateImport(input.env.CONTROL_DB, {
        import_id: item.import_id,
        status: "active",
        availability: "available",
        source_start_at: providerResult.source_start_at,
        source_end_at: providerResult.source_end_at,
        total_range_count: providerResult.ranges.length,
        updated_at: updated,
      });
    } catch (error) {
      const failure =
        error instanceof HistoryServiceError
          ? error
          : new HistoryServiceError("history_invalid", error);
      const range = (await getRanges(input.env.CONTROL_DB, item.import_id))[0];
      if (range !== undefined) {
        await updateFailed(
          input.env.CONTROL_DB,
          item,
          range,
          failure.code === "history_invalid"
            ? "malformed_range"
            : "provider_error",
          nowIso(clock),
          true,
        );
      }
    }
    const detail = await refreshDetail(
      input.env,
      input.tenantId,
      item.import_id,
      input.accountId,
    );
    await reconcileHistoryWork({
      env: input.env,
      item: detail.import,
      ranges: detail.ranges,
      now: nowIso(clock),
    });
    return detail;
  };

  const advance = async (input: Parameters<HistoryService["advance"]>[0]) => {
    const item = await getImport(
      input.env.CONTROL_DB,
      input.tenantId,
      input.importId,
      input.accountId,
    );
    if (item.identity_id !== input.identityId)
      throw new HistoryServiceError("history_not_found");
    const before = await refreshDetail(
      input.env,
      input.tenantId,
      item.import_id,
      input.accountId,
    );
    const range = input.rangeId
      ? before.ranges.find((candidate) => candidate.range_id === input.rangeId)
      : before.ranges.find(
          (candidate) =>
            candidate.status === "active" || candidate.status === "pending",
        );
    if (range === undefined) {
      if (input.rangeId !== undefined)
        throw new HistoryServiceError("history_not_found");
      return before;
    }
    if (
      range.status === "completed" ||
      range.status === "gap" ||
      range.status === "failed" ||
      range.status === "partial"
    )
      return before;

    const now = nowIso(clock);
    for (const candidate of before.ranges) {
      if (candidate.status !== "active" && candidate.status !== "pending")
        continue;
      await ensureHistoryRangeWork(input.env.CONTROL_DB, {
        import_id: item.import_id,
        range_id: candidate.range_id,
        account_id: item.account_id,
        source_cursor: candidate.source_cursor,
        next_attempt_at: now,
        updated_at: now,
      });
    }
    const leaseToken = input.leaseToken ?? crypto.randomUUID();
    const claimed = await claimHistoryRangeWork(input.env.CONTROL_DB, {
      tenant_id: input.tenantId,
      import_id: item.import_id,
      range_id: range.range_id,
      account_id: item.account_id,
      identity_id: item.identity_id,
      source_cursor: range.source_cursor,
      lease_token: leaseToken,
      lease_until:
        input.leaseUntil ??
        new Date(Date.parse(now) + 5 * 60_000).toISOString(),
      now,
      ignore_due: input.leaseToken === undefined,
    });
    if (!claimed) return before;

    const activeItem = HistoryImportSchema.parse(item);
    let result: HistoryProviderAdvanceResult;
    try {
      result = await dependencies.provider.advance({
        owner: providerOwner(activeItem),
        range_id: range.range_id,
        source_cursor: range.source_cursor,
      });
    } catch (error) {
      const failure = providerFailure(error);
      const updated = nowIso(clock);
      await updateFailed(
        input.env.CONTROL_DB,
        item,
        range,
        providerErrorCode(failure),
        updated,
        failure.code === "history_provider_error" ||
          failure.code === "history_provider_timeout",
        leaseToken,
      );
      const detail = await refreshDetail(
        input.env,
        input.tenantId,
        item.import_id,
        input.accountId,
      );
      await reconcileHistoryWork({
        env: input.env,
        item: detail.import,
        ranges: detail.ranges,
        now: updated,
        currentRangeId: range.range_id,
        leaseToken,
      });
      return detail;
    }
    try {
      validateEvents(result.events, item);
      const eventIds = result.events.map((event) => event.event_id);
      const existing = await listExistingEventHashes(
        input.env.CONTROL_DB,
        item.import_id,
        eventIds,
      );
      const existingHashes = new Map(
        existing.map((row) => [row.source_event_id, row.event_hash]),
      );
      const newEvents: ProjectionEventEnvelope[] = [];
      const hashes: Array<{
        import_id: string;
        range_id: string;
        source_event_id: string;
        event_hash: string;
        occurred_at: string;
        created_at: string;
      }> = [];
      for (const event of result.events) {
        const hash = await hashEvent(event);
        const prior = existingHashes.get(event.event_id);
        if (prior !== undefined) {
          if (prior !== hash) throw new HistoryServiceError("history_conflict");
          continue;
        }
        newEvents.push(event);
        // A repeated provider event is counted once before the checkpoint is written.
        existingHashes.set(event.event_id, hash);
        hashes.push({
          import_id: item.import_id,
          range_id: range.range_id,
          source_event_id: event.event_id,
          event_hash: hash,
          occurred_at: event.occurred_at,
          created_at: nowIso(clock),
        });
      }
      await applyEvents({
        env: input.env,
        tenantId: input.tenantId,
        accountId: item.account_id,
        identityId: item.identity_id,
        importId: item.import_id,
        rangeId: range.range_id,
        events: newEvents,
      });
      await insertEventHashes(input.env.CONTROL_DB, hashes);
      const updated = nowIso(clock);
      const eventCount = range.event_count + newEvents.length;
      const nextRangeStatus =
        result.status === "completed"
          ? "completed"
          : result.status === "partial"
            ? "partial"
            : result.status === "failed"
              ? "failed"
              : "active";
      await updateRange(input.env.CONTROL_DB, {
        range_id: range.range_id,
        status: nextRangeStatus,
        source_cursor: result.next_cursor,
        gap_code: result.gap_code,
        error_code: result.error_code,
        event_count: eventCount,
        attempt_count: range.attempt_count,
        updated_at: updated,
        completed_at: nextRangeStatus === "active" ? null : updated,
        lease_token: leaseToken,
      });
      const allRanges = await getRanges(input.env.CONTROL_DB, item.import_id);
      const completed = allRanges.filter(
        (candidate) => candidate.status === "completed",
      ).length;
      const gaps = allRanges.filter(
        (candidate) =>
          candidate.status === "gap" ||
          candidate.status === "partial" ||
          candidate.status === "failed",
      ).length;
      const failed = allRanges.some(
        (candidate) => candidate.status === "failed",
      );
      const hasPending = allRanges.some(
        (candidate) =>
          candidate.status === "pending" || candidate.status === "active",
      );
      const importStatus: HistoryImport["status"] = hasPending
        ? "active"
        : failed || result.status === "failed"
          ? "failed"
          : result.status === "partial" || gaps > 0
            ? "partial"
            : completed === allRanges.length
              ? "completed"
              : "active";
      await updateImport(input.env.CONTROL_DB, {
        import_id: item.import_id,
        status: importStatus,
        availability: importStatus === "failed" ? "unavailable" : "available",
        event_count: item.event_count + newEvents.length,
        completed_range_count: completed,
        total_range_count: allRanges.length,
        gap_count: gaps,
        last_error_code: result.error_code,
        updated_at: updated,
        completed_at: importStatus === "active" ? null : updated,
        lease_token: leaseToken,
        range_id: range.range_id,
      });
    } catch (error) {
      const failure =
        error instanceof HistoryServiceError
          ? error
          : new HistoryServiceError("history_provider_error", error);
      const updated = nowIso(clock);
      await updateFailed(
        input.env.CONTROL_DB,
        item,
        range,
        failure.code === "history_conflict"
          ? "duplicate_event_conflict"
          : failure.code === "history_invalid"
            ? "malformed_range"
            : "provider_error",
        updated,
        failure.code === "history_conflict" ||
          failure.code === "history_invalid",
        leaseToken,
      );
    }
    const detail = await refreshDetail(
      input.env,
      input.tenantId,
      item.import_id,
      input.accountId,
    );
    await reconcileHistoryWork({
      env: input.env,
      item: detail.import,
      ranges: detail.ranges,
      now: nowIso(clock),
      currentRangeId: range.range_id,
      leaseToken,
    });
    return detail;
  };

  return { start, advance };
};

export const createHistoryService = (
  dependencies: HistoryServiceDependencies,
): HistoryService => createService(dependencies);
