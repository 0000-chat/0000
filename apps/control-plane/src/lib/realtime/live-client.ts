import {
  REALTIME_SUBPROTOCOL,
  RealtimeConnectedFrameSchema,
  RealtimePositionSchema,
  RealtimeProjectionChangesFrameSchema,
  RealtimeResetRequiredFrameSchema,
  RealtimeServerFrameSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
  type Command,
  type CommandStatus,
  type RealtimePosition,
  type RealtimeServerFrame,
  type RealtimeTicketRequest,
} from "@communicator/contracts";
import { apiClient, type ApiClient } from "@/lib/api/client";
import type {
  RealtimeClient,
  RealtimeConnectOptions,
  RealtimeLegacyListener,
  RealtimeListener,
  RealtimeStatus,
  RealtimeStatusListener,
} from "./client";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

type TicketApi = Pick<ApiClient, "createRealtimeTicket">;

export type RealtimeWebSocketLike = {
  readyState?: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: (() => void) | null;
  close(code?: number, reason?: string): void;
};

export type RealtimeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => RealtimeWebSocketLike;

export type RealtimeTimerScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LiveRealtimeClientOptions = {
  apiClient?: TicketApi;
  webSocket?: RealtimeWebSocketConstructor;
  clock?: () => Date;
  timers?: RealtimeTimerScheduler;
  storage?: Storage;
};

type NormalizedConnectOptions = {
  tenantId: string;
  principalId: string;
  identityIds: string[];
  families: ["projection"];
};

const defaultTimers: RealtimeTimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultWebSocket(): RealtimeWebSocketConstructor {
  return globalThis.WebSocket as unknown as RealtimeWebSocketConstructor;
}

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeOptions(options: RealtimeConnectOptions): NormalizedConnectOptions {
  const identityIds = [...options.identityIds];
  if (identityIds.length === 0 || new Set(identityIds).size !== identityIds.length) {
    throw new Error("Realtime subscriptions must contain unique identities");
  }
  if (options.families.length !== 1 || options.families[0] !== "projection") {
    throw new Error("Realtime subscriptions must use the projection family");
  }
  return {
    tenantId: options.tenantId,
    principalId: options.principalId,
    identityIds,
    families: ["projection"],
  };
}

function sameOptions(left: NormalizedConnectOptions, right: NormalizedConnectOptions) {
  return left.tenantId === right.tenantId
    && left.principalId === right.principalId
    && left.families[0] === right.families[0]
    && left.identityIds.length === right.identityIds.length
    && left.identityIds.every((identityId, index) => identityId === right.identityIds[index]);
}

export function realtimePositionStorageKey(
  tenantId: string,
  principalId: string,
  identityId: string,
) {
  return [
    "communicator.realtime.position.v1",
    encodeURIComponent(tenantId),
    encodeURIComponent(principalId),
    encodeURIComponent(identityId),
  ].join(":");
}

export class LiveRealtimeClient implements RealtimeClient {
  private readonly ticketApi: TicketApi;
  private readonly webSocketConstructor: RealtimeWebSocketConstructor;
  private readonly clock: () => Date;
  private readonly timers: RealtimeTimerScheduler;
  private readonly storage: Storage | undefined;
  private readonly listeners = new Set<RealtimeListener>();
  private readonly statusListeners = new Set<RealtimeStatusListener>();
  private readonly positions = new Map<string, RealtimePosition>();
  private desiredOptions: NormalizedConnectOptions | undefined;
  private socket: RealtimeWebSocketLike | undefined;
  private statusValue: RealtimeStatus = "idle";
  private reconnectTimer: unknown;
  private leaseTimer: unknown;
  private reconnectDelayIndex = 0;
  private connectionToken = 0;
  private closed = true;
  private hasConnected = false;
  private pendingConnect: Promise<void> | undefined;
  private resolvePendingConnect: (() => void) | undefined;
  private rejectPendingConnectPromise: ((reason: unknown) => void) | undefined;

  constructor(options: LiveRealtimeClientOptions = {}) {
    this.ticketApi = options.apiClient ?? apiClient;
    this.webSocketConstructor = options.webSocket ?? defaultWebSocket();
    this.clock = options.clock ?? (() => new Date());
    this.timers = options.timers ?? defaultTimers;
    this.storage = options.storage ?? defaultStorage();
  }

  get status() {
    return this.statusValue;
  }

  get lastSequence() {
    if (!this.desiredOptions) return 0;
    return Math.max(
      0,
      ...this.desiredOptions.identityIds.map((identityId) =>
        this.positionFor(identityId)?.sequence ?? 0),
    );
  }

  connect(options?: RealtimeConnectOptions): Promise<void> {
    if (!options) {
      if (this.statusValue === "connected") return Promise.resolve();
      return this.pendingConnect ?? Promise.resolve();
    }

    const normalized = normalizeOptions(options);
    const scopeChanged = !this.desiredOptions || !sameOptions(this.desiredOptions, normalized);
    if (scopeChanged) {
      this.stopSocket("realtime scope changed");
      this.rejectPendingConnect(new Error("Realtime connection scope changed"));
      this.desiredOptions = normalized;
      this.hasConnected = false;
      this.reconnectDelayIndex = 0;
    }

    this.closed = false;
    if (this.statusValue === "connected" && !scopeChanged) return Promise.resolve();
    if (this.pendingConnect) return this.pendingConnect;

    this.pendingConnect = new Promise<void>((resolve, reject) => {
      this.resolvePendingConnect = resolve;
      this.rejectPendingConnectPromise = reject;
    });
    this.setStatus(this.hasConnected ? "reconnecting" : "connecting");
    this.clearReconnectTimer();
    this.startAttempt();
    return this.pendingConnect;
  }

  subscribe(listener: RealtimeLegacyListener): () => void;
  subscribe(listener: RealtimeListener): () => void;
  subscribe(listener: RealtimeListener | RealtimeLegacyListener) {
    this.listeners.add(listener as RealtimeListener);
    return () => this.listeners.delete(listener as RealtimeListener);
  }

  subscribeStatus(listener: RealtimeStatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.desiredOptions = undefined;
    this.hasConnected = false;
    this.reconnectDelayIndex = 0;
    this.clearReconnectTimer();
    this.clearLeaseTimer();
    this.rejectPendingConnect(new Error("Realtime client closed"));
    this.stopSocket("realtime client closed");
    this.setStatus("idle");
  }

  reset() {
    if (!this.desiredOptions) return;
    for (const identityId of this.desiredOptions.identityIds) {
      this.removePosition(identityId);
    }
    this.reconnectDelayIndex = 0;
  }

  publishCommand(_command: Command, _statuses?: CommandStatus[]) {
    // Live command delivery remains an HTTP concern. This keeps the shared runtime shape compatible with simulation hooks.
  }

  publishMessage(_input: {
    tenantId: string;
    identityId: string;
    connectionId: string;
    conversationId: string;
    lastMessagePreview: string;
    lastActivityAt: string;
    unreadDelta: number;
  }) {
    // Live projection changes carry invalidation metadata, not simulated message payloads.
  }

  private setStatus(status: RealtimeStatus) {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private startAttempt() {
    const desiredOptions = this.desiredOptions;
    if (this.closed || !desiredOptions) return;
    const attemptToken = ++this.connectionToken;
    const request = this.ticketRequest(desiredOptions);
    void this.ticketApi.createRealtimeTicket(request)
      .then((response) => {
        if (this.closed || attemptToken !== this.connectionToken || this.desiredOptions !== desiredOptions) return;
        const parsed = RealtimeTicketResponseSchema.safeParse(response);
        if (!parsed.success) throw new Error("Communicator API returned an invalid realtime ticket");
        const socket = new this.webSocketConstructor(parsed.data.websocket_url, REALTIME_SUBPROTOCOL);
        if (this.closed || attemptToken !== this.connectionToken || this.desiredOptions !== desiredOptions) {
          socket.close(1000, "stale realtime attempt");
          return;
        }
        this.socket = socket;
        const socketToken = ++this.connectionToken;
        socket.onopen = () => undefined;
        socket.onmessage = (event) => this.handleMessage(socket, socketToken, event.data);
        socket.onerror = () => undefined;
        socket.onclose = (event) => this.handleClose(socket, socketToken, event);
      })
      .catch(() => {
        if (this.closed || attemptToken !== this.connectionToken || this.desiredOptions !== desiredOptions) return;
        this.scheduleReconnect();
      });
  }

  private handleMessage(socket: RealtimeWebSocketLike, socketToken: number, data: unknown) {
    if (this.closed || this.socket !== socket || socketToken !== this.connectionToken) return;
    const frame = this.parseFrame(data);
    if (!frame) {
      socket.close(1008, "invalid realtime frame");
      return;
    }
    if (frame.type === "connected") {
      this.handleConnected(socket, frame);
      return;
    }
    if (frame.type === "projection.changes") {
      this.handleChanges(frame);
      return;
    }
    this.handleReset(frame);
  }

  private parseFrame(data: unknown): RealtimeServerFrame | undefined {
    if (typeof data !== "string") return undefined;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
    const parsed = RealtimeServerFrameSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : undefined;
  }

  private handleConnected(
    socket: RealtimeWebSocketLike,
    frame: Extract<RealtimeServerFrame, { type: "connected" }>,
  ) {
    const desiredOptions = this.desiredOptions;
    if (!desiredOptions || frame.tenant_id !== desiredOptions.tenantId) {
      socket.close(1008, "invalid realtime frame");
      return;
    }

    const positions = frame.positions.filter((position) =>
      desiredOptions.identityIds.includes(position.identity_id));
    if (positions.length === 0) {
      socket.close(1008, "invalid realtime frame");
      return;
    }
    for (const position of positions) this.acceptConnectedPosition(position);

    const safeFrame = RealtimeConnectedFrameSchema.safeParse({ ...frame, positions });
    if (!safeFrame.success) {
      socket.close(1008, "invalid realtime frame");
      return;
    }

    this.hasConnected = true;
    this.reconnectDelayIndex = 0;
    this.setStatus("connected");
    this.scheduleLease(socket, safeFrame.data.connection_expires_at);
    this.resolvePendingConnect?.();
    this.pendingConnect = undefined;
    this.resolvePendingConnect = undefined;
    this.rejectPendingConnectPromise = undefined;
    this.emit(safeFrame.data);
  }

  private handleChanges(
    frame: Extract<RealtimeServerFrame, { type: "projection.changes" }>,
  ) {
    const desiredOptions = this.desiredOptions;
    if (!desiredOptions || frame.tenant_id !== desiredOptions.tenantId) return;
    if (!desiredOptions.identityIds.includes(frame.identity_id)) return;

    const position = this.positionFor(frame.identity_id);
    if (position && frame.generation !== position.generation) return;
    const baseline = position?.sequence ?? 0;
    const changes = frame.changes.filter((change) => change.sequence > baseline);
    if (changes.length === 0) return;

    const safeFrame = RealtimeProjectionChangesFrameSchema.safeParse({
      ...frame,
      from_sequence: changes[0]!.sequence,
      to_sequence: changes.at(-1)!.sequence + 1,
      changes,
    });
    if (!safeFrame.success) return;
    this.writePosition({
      identity_id: frame.identity_id,
      generation: frame.generation,
      sequence: changes.at(-1)!.sequence,
    });
    this.emit(safeFrame.data);
  }

  private handleReset(
    frame: Extract<RealtimeServerFrame, { type: "reset_required" }>,
  ) {
    const desiredOptions = this.desiredOptions;
    if (!desiredOptions || frame.tenant_id !== desiredOptions.tenantId) return;
    if (!desiredOptions.identityIds.includes(frame.identity_id)) return;

    const safeFrame = RealtimeResetRequiredFrameSchema.safeParse(frame);
    if (!safeFrame.success) return;
    this.writePosition({
      identity_id: frame.identity_id,
      generation: frame.generation,
      sequence: frame.latest_sequence,
    });
    this.emit(safeFrame.data);
  }

  private acceptConnectedPosition(position: RealtimePosition) {
    const existing = this.positionFor(position.identity_id);
    if (!existing
      || position.generation > existing.generation
      || (position.generation === existing.generation && position.sequence > existing.sequence)) {
      this.writePosition(position);
    }
  }

  private handleClose(
    socket: RealtimeWebSocketLike,
    socketToken: number,
    event: { code: number; reason: string; wasClean: boolean },
  ) {
    if (this.socket !== socket || socketToken !== this.connectionToken) return;
    this.socket = undefined;
    this.clearLeaseTimer();
    if (this.closed) return;
    if (event.code === 1000) {
      this.hasConnected = false;
      this.setStatus("idle");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(delayOverride?: number) {
    if (this.closed || !this.desiredOptions || this.reconnectTimer !== undefined) return;
    const delay = delayOverride ?? RECONNECT_DELAYS_MS[
      Math.min(this.reconnectDelayIndex++, RECONNECT_DELAYS_MS.length - 1)
    ] ?? RECONNECT_DELAYS_MS.at(-1)!;
    this.setStatus("reconnecting");
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || !this.desiredOptions) return;
      this.startAttempt();
    }, delay);
  }

  private scheduleLease(socket: RealtimeWebSocketLike, expiresAt: string) {
    this.clearLeaseTimer();
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) return;
    const delay = Math.max(0, expiresAtMs - this.clock().getTime());
    this.leaseTimer = this.timers.setTimeout(() => {
      this.leaseTimer = undefined;
      if (this.closed || this.socket !== socket) return;
      this.socket = undefined;
      ++this.connectionToken;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close(1000, "realtime lease expired");
      this.scheduleReconnect(0);
    }, delay);
  }

  private stopSocket(reason: string) {
    this.clearLeaseTimer();
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = undefined;
    ++this.connectionToken;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000, reason);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === undefined) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearLeaseTimer() {
    if (this.leaseTimer === undefined) return;
    this.timers.clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private rejectPendingConnect(error: Error) {
    if (!this.pendingConnect) return;
    this.pendingConnect = undefined;
    this.resolvePendingConnect = undefined;
    this.rejectPendingConnectPromise?.(error);
    this.rejectPendingConnectPromise = undefined;
  }

  private ticketRequest(options: NormalizedConnectOptions): RealtimeTicketRequest {
    const resume = options.identityIds.flatMap((identityId) => {
      const position = this.positionFor(identityId);
      return position
        ? [{
          identity_id: identityId,
          generation: position.generation,
          after_sequence: position.sequence,
        }]
        : [];
    });
    const request = {
      schema_version: 1 as const,
      subscriptions: options.identityIds.map((identityId) => ({
        identity_id: identityId,
        families: ["projection"] as ["projection"],
      })),
      ...(resume.length > 0 ? { resume } : {}),
    };
    return RealtimeTicketRequestSchema.parse(request);
  }

  private positionFor(identityId: string) {
    const options = this.desiredOptions;
    if (!options) return undefined;
    const key = realtimePositionStorageKey(options.tenantId, options.principalId, identityId);
    const inMemory = this.positions.get(key);
    if (inMemory) return inMemory;
    if (!this.storage) return undefined;
    let stored: string | null;
    try {
      stored = this.storage.getItem(key);
    } catch {
      return undefined;
    }
    if (stored === null) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(stored) as unknown;
    } catch {
      this.removeStorageItem(key);
      return undefined;
    }
    const parsed = RealtimePositionSchema.safeParse(value);
    if (!parsed.success || parsed.data.identity_id !== identityId) {
      this.removeStorageItem(key);
      return undefined;
    }
    this.positions.set(key, parsed.data);
    return parsed.data;
  }

  private writePosition(position: RealtimePosition) {
    const parsed = RealtimePositionSchema.safeParse(position);
    if (!parsed.success || !this.desiredOptions) return;
    const key = realtimePositionStorageKey(
      this.desiredOptions.tenantId,
      this.desiredOptions.principalId,
      position.identity_id,
    );
    this.positions.set(key, parsed.data);
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(parsed.data));
    } catch {
      // The in-memory position still protects this live connection if storage is unavailable.
    }
  }

  private removePosition(identityId: string) {
    if (!this.desiredOptions) return;
    const key = realtimePositionStorageKey(
      this.desiredOptions.tenantId,
      this.desiredOptions.principalId,
      identityId,
    );
    this.positions.delete(key);
    this.removeStorageItem(key);
  }

  private removeStorageItem(key: string) {
    try {
      this.storage?.removeItem(key);
    } catch {
      // Ignore storage failures. The browser can reconnect with a fresh baseline.
    }
  }

  private emit(event: RealtimeServerFrame) {
    for (const listener of this.listeners) listener(event);
  }
}
