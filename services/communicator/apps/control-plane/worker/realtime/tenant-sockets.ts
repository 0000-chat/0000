import {
  MAX_REALTIME_CHANGES_PER_FRAME,
  MAX_REALTIME_REPLAY_CHANGES,
  MAX_REALTIME_SOCKETS_PER_PRINCIPAL,
  MAX_REALTIME_SOCKETS_PER_TENANT,
  REALTIME_CONNECTION_TTL_MS,
  RealtimeIdSchema,
  RealtimeResetRequiredFrameSchema,
  RealtimeProjectionChangeSchema,
  RealtimeServerFrameSchema,
  type RealtimeProjectionChange,
  type RealtimeResetRequiredFrame,
  type RealtimeServerFrame,
} from "@communicator/contracts";
import {
  parseRealtimeAttachment,
  serializeRealtimeAttachment,
  type RealtimeSocketAttachment,
} from "./contracts";

export const REALTIME_INTERNAL_HOST = "tenant-projection.internal";
export const REALTIME_INTERNAL_PATH = "/realtime";
export const REALTIME_CONTEXT_HEADER = "X-Communicator-Realtime-Context";
export const REALTIME_INTERNAL_CONTEXT_HEADER = REALTIME_CONTEXT_HEADER;
export const REALTIME_PLATFORM_CREDENTIAL_HEADER =
  "X-Communicator-Platform-Credential";
export const REALTIME_SOCKET_TAG = "realtime";

type RealtimeReplayStorageRow = {
  sequence: number;
  event_type: string;
  connection_id: string;
  conversation_id: string;
  account_id: string;
  occurred_at: string;
  generation: number;
};

export type RealtimeReplayRow = RealtimeProjectionChange & {
  readonly account_id: string;
  readonly generation: number;
};

export type RealtimeBroadcastChange = RealtimeProjectionChange & {
  readonly account_id: string;
  readonly identity_id: string;
  readonly generation: number;
};

export type RealtimeSocket = Pick<
  WebSocket,
  "close" | "deserializeAttachment" | "send" | "serializeAttachment"
>;

export type RealtimeChangeAuthorizer = (
  socket: RealtimeSocket,
  attachment: RealtimeSocketAttachment,
  change: RealtimeBroadcastChange,
) => boolean;

type RealtimeGroupedChange = RealtimeProjectionChange & {
  readonly account_id: string;
  readonly identity_id: string;
  readonly generation: number;
};

const safeInteger = (value: unknown, positive: boolean): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  (positive ? value > 0 : value >= 0);

const helperFailure = (): Error => new Error("Invalid realtime socket data");

const parseReplayRow = (row: RealtimeReplayStorageRow): RealtimeReplayRow => {
  if (!safeInteger(row.generation, true)) throw helperFailure();
  const parsed = RealtimeProjectionChangeSchema.safeParse({
    sequence: row.sequence,
    event_type: row.event_type,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    occurred_at: row.occurred_at,
  });
  if (!parsed.success) throw helperFailure();
  if (!RealtimeIdSchema.safeParse(row.account_id).success) {
    throw helperFailure();
  }
  return {
    ...parsed.data,
    account_id: row.account_id,
    generation: row.generation,
  };
};

const validateReplayInput = (
  identityId: string,
  generation: number,
  afterSequence: number,
  limit: number,
): void => {
  if (!RealtimeIdSchema.safeParse(identityId).success) throw helperFailure();
  if (!safeInteger(generation, true) || !safeInteger(afterSequence, false)) {
    throw helperFailure();
  }
  if (!safeInteger(limit, true) || limit > MAX_REALTIME_REPLAY_CHANGES + 1) {
    throw helperFailure();
  }
};

/** Read only safe projection-change metadata, with a caller-selected bounded limit. */
export const readRealtimeReplay = (
  sql: SqlStorage,
  identityId: string,
  generation: number,
  afterSequence: number,
  limit: number = MAX_REALTIME_REPLAY_CHANGES + 1,
): RealtimeReplayRow[] => {
  validateReplayInput(identityId, generation, afterSequence, limit);
  const rows = sql
    .exec<RealtimeReplayStorageRow>(
      "SELECT identity_sequence AS sequence, event_type, account_id, connection_id, conversation_id, occurred_at, generation FROM projection_changes WHERE identity_id = ? AND generation = ? AND identity_sequence > ? ORDER BY identity_sequence ASC LIMIT ?",
      identityId,
      generation,
      afterSequence,
      limit,
    )
    .toArray();
  return rows.map(parseReplayRow);
};

export const batchRealtimeChanges = (
  changes: readonly RealtimeProjectionChange[],
  maxChangesPerFrame: number = MAX_REALTIME_CHANGES_PER_FRAME,
): RealtimeProjectionChange[][] => {
  if (
    !safeInteger(maxChangesPerFrame, true) ||
    maxChangesPerFrame > MAX_REALTIME_CHANGES_PER_FRAME
  ) {
    throw helperFailure();
  }
  const parsed = changes.map((change) => {
    const result = RealtimeProjectionChangeSchema.safeParse(change);
    if (!result.success) throw helperFailure();
    return result.data;
  });
  const batches: RealtimeProjectionChange[][] = [];
  for (let offset = 0; offset < parsed.length; offset += maxChangesPerFrame) {
    batches.push(parsed.slice(offset, offset + maxChangesPerFrame));
  }
  return batches;
};

export const sendRealtimeFrame = (
  socket: Pick<WebSocket, "send">,
  frame: RealtimeServerFrame,
): void => {
  const parsed = RealtimeServerFrameSchema.safeParse(frame);
  if (!parsed.success) throw helperFailure();
  socket.send(JSON.stringify(parsed.data));
};

const restoredAttachment = (
  socket: Pick<WebSocket, "deserializeAttachment">,
): RealtimeSocketAttachment | null => {
  try {
    return parseRealtimeAttachment(socket.deserializeAttachment());
  } catch {
    return null;
  }
};

export const tryParseRealtimeAttachment = restoredAttachment;

const closeRealtimeSocket = (
  socket: Pick<WebSocket, "close">,
  code: number,
  reason: string,
): void => {
  try {
    socket.close(code, reason);
  } catch {
    // A socket may already be closed when a hibernated callback runs.
  }
};

const advanceRealtimeAttachment = (
  socket: Pick<WebSocket, "serializeAttachment">,
  attachment: RealtimeSocketAttachment,
  identityId: string,
  generation: number,
  sequence: number,
): RealtimeSocketAttachment => {
  let found = false;
  const positions = attachment.positions.map((position) => {
    if (position.identity_id !== identityId) return position;
    found = true;
    return {
      identity_id: identityId,
      generation,
      sequence,
    };
  });
  if (!found) throw helperFailure();
  const nextAttachment = serializeRealtimeAttachment({
    ...attachment,
    positions,
  });
  socket.serializeAttachment(nextAttachment);
  return nextAttachment;
};

const groupedRealtimeChanges = (
  changes: readonly RealtimeBroadcastChange[],
): Map<string, { generation: number; changes: RealtimeGroupedChange[] }> => {
  const grouped = new Map<
    string,
    { generation: number; changes: RealtimeGroupedChange[] }
  >();
  for (const change of changes) {
    if (
      !RealtimeIdSchema.safeParse(change.identity_id).success ||
      !RealtimeIdSchema.safeParse(change.account_id).success ||
      !safeInteger(change.generation, true)
    ) {
      continue;
    }
    const parsed = RealtimeProjectionChangeSchema.safeParse({
      sequence: change.sequence,
      event_type: change.event_type,
      connection_id: change.connection_id,
      conversation_id: change.conversation_id,
      occurred_at: change.occurred_at,
    });
    if (!parsed.success) continue;

    const existing = grouped.get(change.identity_id);
    if (existing === undefined) {
      grouped.set(change.identity_id, {
        generation: change.generation,
        changes: [
          {
            ...parsed.data,
            account_id: change.account_id,
            identity_id: change.identity_id,
            generation: change.generation,
          },
        ],
      });
      continue;
    }
    if (existing.generation === change.generation) {
      existing.changes.push({
        ...parsed.data,
        account_id: change.account_id,
        identity_id: change.identity_id,
        generation: change.generation,
      });
    }
  }
  return grouped;
};

const publicRealtimeChange = (
  change: RealtimeGroupedChange,
): RealtimeProjectionChange => {
  const {
    account_id: _accountId,
    identity_id: _identityId,
    generation: _generation,
    ...publicChange
  } = change;
  return publicChange;
};

export const realtimeLeaseIsCurrent = (
  attachment: Pick<RealtimeSocketAttachment, "lease_expires_at">,
  now = Date.now(),
): boolean => {
  const expiresAt = Date.parse(attachment.lease_expires_at);
  return Number.isSafeInteger(expiresAt) && expiresAt > now;
};

/** Broadcast only newly persisted, identity-scoped projection metadata. */
export const broadcastRealtimeChanges = (
  sockets: readonly RealtimeSocket[],
  tenantId: string,
  changes: readonly RealtimeBroadcastChange[],
  authorizeChange?: RealtimeChangeAuthorizer,
): void => {
  if (changes.length === 0) return;
  const grouped = groupedRealtimeChanges(changes);

  for (const socket of sockets) {
    const attachment = tryParseRealtimeAttachment(socket);
    if (attachment === null) {
      closeRealtimeSocket(socket, 1008, "invalid realtime attachment");
      continue;
    }
    if (attachment.tenant_id !== tenantId) {
      closeRealtimeSocket(socket, 1008, "invalid realtime attachment");
      continue;
    }
    if (!realtimeLeaseIsCurrent(attachment)) {
      closeRealtimeSocket(socket, 1000, "realtime lease expired");
      continue;
    }

    try {
      let currentAttachment = attachment;
      for (const subscription of currentAttachment.subscriptions) {
        if (!subscription.families.includes("projection")) continue;
        const group = grouped.get(subscription.identity_id);
        if (group === undefined) continue;
        const position = currentAttachment.positions.find(
          (candidate) => candidate.identity_id === subscription.identity_id,
        );
        if (
          position === undefined ||
          position.generation !== group.generation
        ) {
          continue;
        }
        const pending = group.changes.filter(
          (change) => change.sequence > position.sequence,
        );
        if (pending.length === 0) continue;

        let denied = false;
        const permitted: RealtimeGroupedChange[] = [];
        for (const change of pending) {
          if (
            authorizeChange !== undefined &&
            !authorizeChange(socket, currentAttachment, change)
          ) {
            denied = true;
            break;
          }
          permitted.push(change);
        }

        const publicChanges = permitted.map(publicRealtimeChange);
        for (const frameChanges of batchRealtimeChanges(publicChanges)) {
          const first = frameChanges[0];
          const last = frameChanges.at(-1);
          if (first === undefined || last === undefined) continue;
          if (!realtimeLeaseIsCurrent(currentAttachment)) {
            closeRealtimeSocket(socket, 1000, "realtime lease expired");
            break;
          }
          sendRealtimeFrame(socket, {
            schema_version: 1,
            type: "projection.changes",
            tenant_id: tenantId,
            identity_id: subscription.identity_id,
            generation: group.generation,
            from_sequence: first.sequence,
            to_sequence: last.sequence + 1,
            changes: frameChanges,
          });
          currentAttachment = advanceRealtimeAttachment(
            socket,
            currentAttachment,
            subscription.identity_id,
            group.generation,
            last.sequence,
          );
        }

        if (denied) {
          const latest = pending.at(-1);
          if (latest === undefined) continue;
          if (!realtimeLeaseIsCurrent(currentAttachment)) {
            closeRealtimeSocket(socket, 1000, "realtime lease expired");
            continue;
          }
          sendRealtimeFrame(socket, {
            schema_version: 1,
            type: "reset_required",
            tenant_id: tenantId,
            identity_id: subscription.identity_id,
            generation: group.generation,
            latest_sequence: latest.sequence,
            reason: "history_unavailable",
          });
          currentAttachment = advanceRealtimeAttachment(
            socket,
            currentAttachment,
            subscription.identity_id,
            group.generation,
            latest.sequence,
          );
        }
      }
    } catch {
      closeRealtimeSocket(socket, 1011, "realtime socket unavailable");
    }
  }
};

/** Tell every valid current subscription to use the next rebuild generation. */
export const resetRealtimeSocketsForRebuild = (
  sockets: readonly RealtimeSocket[],
  tenantId: string,
  nextGeneration: number,
  authorizeSocket: (
    socket: RealtimeSocket,
    attachment: RealtimeSocketAttachment,
  ) => boolean = () => true,
): void => {
  if (
    !RealtimeIdSchema.safeParse(tenantId).success ||
    !safeInteger(nextGeneration, true)
  ) {
    return;
  }

  for (const socket of sockets) {
    const attachment = tryParseRealtimeAttachment(socket);
    if (attachment === null || attachment.tenant_id !== tenantId) {
      closeRealtimeSocket(socket, 1008, "invalid realtime attachment");
      continue;
    }
    if (!realtimeLeaseIsCurrent(attachment)) {
      closeRealtimeSocket(socket, 1000, "realtime lease expired");
      continue;
    }
    if (!authorizeSocket(socket, attachment)) {
      closeRealtimeSocket(socket, 1008, "realtime authority revoked");
      continue;
    }
    let expiredDuringReset = false;
    try {
      for (const subscription of attachment.subscriptions) {
        if (!realtimeLeaseIsCurrent(attachment)) {
          closeRealtimeSocket(socket, 1000, "realtime lease expired");
          expiredDuringReset = true;
          break;
        }
        const frame: RealtimeResetRequiredFrame =
          RealtimeResetRequiredFrameSchema.parse({
            schema_version: 1,
            type: "reset_required",
            tenant_id: tenantId,
            identity_id: subscription.identity_id,
            generation: nextGeneration,
            latest_sequence: 0,
            reason: "generation_changed",
          });
        sendRealtimeFrame(socket, frame);
      }
    } catch {
      closeRealtimeSocket(socket, 1011, "realtime socket unavailable");
      continue;
    }
    if (expiredDuringReset) continue;
    closeRealtimeSocket(socket, 1012, "projection rebuild in progress");
  }
};

export const countPrincipalSockets = (
  sockets: readonly Pick<WebSocket, "deserializeAttachment">[],
  principalId: string,
): number => {
  if (!RealtimeIdSchema.safeParse(principalId).success) return 0;
  let count = 0;
  for (const socket of sockets) {
    const attachment = restoredAttachment(socket);
    if (attachment?.principal_id === principalId) count += 1;
  }
  return count;
};

export const nextSocketExpiry = (
  sockets: readonly Pick<WebSocket, "deserializeAttachment">[],
): number | null => {
  let earliest: number | null = null;
  for (const socket of sockets) {
    const attachment = restoredAttachment(socket);
    if (attachment === null) continue;
    const expiry = Date.parse(attachment.lease_expires_at);
    if (!Number.isSafeInteger(expiry)) continue;
    if (earliest === null || expiry < earliest) earliest = expiry;
  }
  return earliest;
};

export const serializeSafeRealtimeAttachment = (
  attachment: unknown,
): RealtimeSocketAttachment => serializeRealtimeAttachment(attachment);

export const realtimeSocketCapacity = {
  tenant: MAX_REALTIME_SOCKETS_PER_TENANT,
  principal: MAX_REALTIME_SOCKETS_PER_PRINCIPAL,
} as const;

export const realtimeConnectionExpiry = (
  now = Date.now(),
  maximum?: string,
): string => {
  const nominal = now + REALTIME_CONNECTION_TTL_MS;
  const maximumMs =
    maximum === undefined ? Number.POSITIVE_INFINITY : Date.parse(maximum);
  const expiry = Number.isSafeInteger(maximumMs)
    ? Math.min(nominal, maximumMs)
    : nominal;
  return new Date(expiry).toISOString();
};

export { parseRealtimeAttachment };
