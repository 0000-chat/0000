import type {
  ApplyProjectionBatchInput,
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";
import {
  ApplyProjectionBatchInputSchema,
  MAX_PROJECTION_BATCH_BYTES,
  MAX_PROJECTION_BATCH_EVENTS,
  compareOpaqueEventIds,
} from "@communicator/contracts";
import { canonicalJsonLineBytes, bytesEqual } from "../archive/canonical-json";
import { sha256Hex } from "../archive/codec";
import { isArchiveError } from "../archive/errors";
import { isProjectionError, projectionError, type ProjectionError } from "./errors";

/**
 * The value passed from asynchronous preflight into the synchronous projection
 * transaction. Canonical bytes are retained in a module-private WeakMap so
 * duplicate grouping compares exact bytes without widening this internal
 * value's shape or exposing transport data.
 */
export type PreparedProjectionEvent = {
  readonly event: ProjectionEventEnvelope;
  readonly connection: ProjectionConnectionBinding;
  readonly eventHash: string;
  readonly canonicalLineBytes: number;
  readonly observedMs: number;
  readonly occurredMs: number;
};

export type PreparedCheckpointMutation = {
  readonly kind: string;
  readonly value: string;
  readonly lastObservedAt: string;
  readonly lastObservedMs: number;
  readonly lastEventId: string;
};

export type PreparedProjectionBatch = {
  readonly tenantId: string;
  readonly inputEventCount: number;
  readonly events: readonly PreparedProjectionEvent[];
  readonly connections: readonly ProjectionConnectionBinding[];
  readonly checkpointMutation: PreparedCheckpointMutation | null;
};

const RESERVED_REPLAY_CHECKPOINT_KIND = "r2_manifest_cursor";
const canonicalLinesByPreparedEvent = new WeakMap<
  PreparedProjectionEvent,
  Uint8Array
>();

const sameBinding = (
  left: ProjectionConnectionBinding,
  right: ProjectionConnectionBinding,
): boolean =>
  left.account_id === right.account_id &&
  left.connection_id === right.connection_id &&
  left.identity_id === right.identity_id &&
  left.platform === right.platform;

const parseInstant = (timestamp: string): number => {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    throw projectionError("projection_invalid");
  }
  return parsed;
};

export const mapArchiveFailure = (error: unknown): ProjectionError => {
  if (isProjectionError(error)) return error;
  if (isArchiveError(error)) {
    switch (error.code) {
      case "archive_invalid":
      case "archive_corrupt":
      case "archive_not_found":
        return projectionError("projection_invalid", error);
      case "archive_tenant_mismatch":
        return projectionError("projection_tenant_mismatch", error);
      case "archive_too_large":
        return projectionError("projection_too_large", error);
      case "archive_conflict":
        return projectionError("projection_conflict", error);
      case "archive_unavailable":
        return projectionError("projection_unavailable", error);
    }
  }
  return projectionError("projection_unavailable", error);
};

const parseAttachmentCrossFields = (event: ProjectionEventEnvelope): void => {
  if (event.event_type !== "attachment.observed") return;
  const payload = event.payload as {
    sha256: string | null;
    r2_key: string | null;
  };
  if (payload.r2_key === null) return;
  if (
    payload.sha256 === null ||
    payload.r2_key !== `media/${event.tenant_id}/${payload.sha256}`
  ) {
    throw projectionError("projection_invalid");
  }
};

const hasOversizedEventArray = (input: unknown): boolean => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const eventsDescriptor = Object.getOwnPropertyDescriptor(input, "events");
    if (
      !eventsDescriptor ||
      !eventsDescriptor.enumerable ||
      !("value" in eventsDescriptor)
    ) {
      return false;
    }
    const events = eventsDescriptor.value;
    if (!Array.isArray(events) || Object.getPrototypeOf(events) !== Array.prototype) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(events, "length");
    return (
      lengthDescriptor !== undefined &&
      "value" in lengthDescriptor &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value > MAX_PROJECTION_BATCH_EVENTS
    );
  } catch {
    return false;
  }
};

const parseAndSnapshotBatch = (
  input: unknown,
): ApplyProjectionBatchInput => {
  try {
    if (hasOversizedEventArray(input)) {
      throw projectionError("projection_too_large");
    }
    const parsed = ApplyProjectionBatchInputSchema.safeParse(input);
    if (!parsed.success) throw projectionError("projection_invalid");
    return structuredClone(parsed.data);
  } catch (error) {
    if (isProjectionError(error)) throw error;
    throw projectionError("projection_invalid", error);
  }
};

const validateExactBindings = (
  parsed: ApplyProjectionBatchInput,
): Map<string, ProjectionConnectionBinding> => {
  if (parsed.connections.length < 1 || parsed.connections.length > MAX_PROJECTION_BATCH_EVENTS) {
    throw projectionError("projection_conflict");
  }

  const byAccount = new Map<string, ProjectionConnectionBinding>();
  const byConnection = new Map<string, ProjectionConnectionBinding>();
  for (const connection of parsed.connections) {
    if (byAccount.has(connection.account_id)) {
      throw projectionError("projection_invalid");
    }
    const priorConnection = byConnection.get(connection.connection_id);
    if (priorConnection !== undefined && !sameBinding(priorConnection, connection)) {
      throw projectionError("projection_conflict");
    }
    byAccount.set(connection.account_id, connection);
    byConnection.set(connection.connection_id, connection);
  }

  const eventAccounts = new Set<string>();
  const allowedIdentityIds = new Set(parsed.authorization.allowed_identity_ids);
  for (const event of parsed.events) {
    if (event.tenant_id !== parsed.tenant_id) {
      throw projectionError("projection_tenant_mismatch");
    }
    if (!allowedIdentityIds.has(event.identity_id)) {
      throw projectionError("projection_forbidden");
    }
    parseAttachmentCrossFields(event);

    const connection = byAccount.get(event.account_id);
    if (connection === undefined) throw projectionError("projection_conflict");
    if (
      connection.identity_id !== event.identity_id ||
      connection.platform !== event.platform
    ) {
      throw projectionError("projection_conflict");
    }
    eventAccounts.add(event.account_id);
  }

  if (eventAccounts.size !== byAccount.size) {
    throw projectionError("projection_conflict");
  }
  return byAccount;
};

const sortPreparedEvents = (
  events: PreparedProjectionEvent[],
): PreparedProjectionEvent[] => {
  events.sort((left, right) => {
    if (left.observedMs < right.observedMs) return -1;
    if (left.observedMs > right.observedMs) return 1;
    return compareOpaqueEventIds(left.event.event_id, right.event.event_id);
  });
  return events;
};

/**
 * Parse, snapshot, validate, canonicalize, hash, group, and order one live
 * batch. This function performs no SQL and completes every asynchronous hash
 * before returning a value that may be handed to the transaction.
 */
export const prepareProjectionBatch = async (
  input: unknown,
): Promise<PreparedProjectionBatch> => {
  const parsed = parseAndSnapshotBatch(input);
  if (parsed.mode !== "live" || parsed.rebuild_id !== null) {
    throw projectionError("projection_invalid");
  }

  const byAccount = validateExactBindings(parsed);
  const canonicalLines: Uint8Array[] = [];
  let aggregateBytes = 0;
  for (const event of parsed.events) {
    let line: Uint8Array;
    try {
      line = canonicalJsonLineBytes(event);
    } catch (error) {
      throw mapArchiveFailure(error);
    }
    aggregateBytes += line.byteLength;
    if (aggregateBytes > MAX_PROJECTION_BATCH_BYTES) {
      throw projectionError("projection_too_large");
    }
    canonicalLines.push(line);
  }

  let hashes: string[];
  try {
    hashes = await Promise.all(canonicalLines.map((line) => sha256Hex(line)));
  } catch (error) {
    throw mapArchiveFailure(error);
  }

  const uniqueById = new Map<string, PreparedProjectionEvent>();
  for (let index = 0; index < parsed.events.length; index += 1) {
    const event = parsed.events[index];
    const canonicalLine = canonicalLines[index];
    const eventHash = hashes[index];
    if (event === undefined || canonicalLine === undefined || eventHash === undefined) {
      throw projectionError("projection_invalid");
    }
    const connection = byAccount.get(event.account_id);
    if (connection === undefined) throw projectionError("projection_conflict");

    const candidate: PreparedProjectionEvent = {
      event,
      connection,
      eventHash,
      canonicalLineBytes: canonicalLine.byteLength,
      observedMs: parseInstant(event.observed_at),
      occurredMs: parseInstant(event.occurred_at),
    };
    canonicalLinesByPreparedEvent.set(candidate, canonicalLine);
    const prior = uniqueById.get(event.event_id);
    if (prior !== undefined) {
      const priorCanonicalLine = canonicalLinesByPreparedEvent.get(prior);
      if (
        priorCanonicalLine === undefined ||
        !bytesEqual(priorCanonicalLine, canonicalLine) ||
        !sameBinding(prior.connection, candidate.connection)
      ) {
        throw projectionError("projection_conflict");
      }
      continue;
    }
    uniqueById.set(event.event_id, candidate);
  }

  const orderedEvents = sortPreparedEvents([...uniqueById.values()]);
  let checkpointMutation: PreparedCheckpointMutation | null = null;
  if (parsed.checkpoint !== null) {
    if (parsed.checkpoint.kind === RESERVED_REPLAY_CHECKPOINT_KIND) {
      throw projectionError("projection_invalid");
    }
    const lastObservedMs = parseInstant(parsed.checkpoint.last_observed_at);
    const greatest = orderedEvents.at(-1);
    if (
      greatest === undefined ||
      lastObservedMs !== greatest.observedMs ||
      compareOpaqueEventIds(parsed.checkpoint.last_event_id, greatest.event.event_id) !== 0
    ) {
      throw projectionError("projection_conflict");
    }
    checkpointMutation = {
      kind: parsed.checkpoint.kind,
      value: parsed.checkpoint.value,
      lastObservedAt: parsed.checkpoint.last_observed_at,
      lastObservedMs,
      lastEventId: parsed.checkpoint.last_event_id,
    };
  }

  // The caller's parsed graph is already detached by parseAndSnapshotBatch;
  // these arrays/maps contain no references into the RPC argument object.
  return {
    tenantId: parsed.tenant_id,
    inputEventCount: parsed.events.length,
    events: orderedEvents,
    connections: parsed.connections,
    checkpointMutation,
  };
};

/** Task 4 intentionally has no domain state yet; Task 5 supplies handlers. */
export const projectEvent = (
  _event: PreparedProjectionEvent,
  _sql: SqlStorage,
): void => {
  // Audit markers are written by the caller after this no-op hook.
};
