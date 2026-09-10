import {
  MAX_REALTIME_CHANGES_PER_FRAME,
  MAX_REALTIME_REPLAY_CHANGES,
  MAX_REALTIME_SOCKETS_PER_PRINCIPAL,
  MAX_REALTIME_SOCKETS_PER_TENANT,
  REALTIME_CONNECTION_TTL_MS,
  REALTIME_SUBPROTOCOL,
  RealtimeIdSchema,
  RealtimeProjectionChangeSchema,
  RealtimeServerFrameSchema,
  type RealtimeProjectionChange,
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
export const REALTIME_SOCKET_TAG = "realtime";

type RealtimeReplayStorageRow = {
  sequence: number;
  event_type: string;
  connection_id: string;
  conversation_id: string;
  occurred_at: string;
  generation: number;
};

export type RealtimeReplayRow = RealtimeProjectionChange & {
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
  return {
    ...parsed.data,
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
      "SELECT identity_sequence AS sequence, event_type, connection_id, conversation_id, occurred_at, generation FROM projection_changes WHERE identity_id = ? AND generation = ? AND identity_sequence > ? ORDER BY identity_sequence ASC LIMIT ?",
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

export const realtimeConnectionExpiry = (now = Date.now()): string =>
  new Date(now + REALTIME_CONNECTION_TTL_MS).toISOString();

export { parseRealtimeAttachment };
