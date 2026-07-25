const bridgeRealtimeProtocol = "0000.bridge-device.v1";
const maxFrameBytes = 32 * 1024;
const maxWakeIds = 64;

type BridgeRealtimeServerFrame =
  | { type: "wake"; wakeIds: string[] }
  | { controlId: string; type: "control" }
  | { connectionEpoch: string; reason: "connected" | "safety"; type: "resync" }
  | { type: "superseded" }
  | { type: "revoked" };

export type BridgeRealtimeEvent =
  | { reason: "wake" | "resync"; wakeIds: string[] }
  | { controlId: string; reason: "control" }
  | { reason: "superseded" | "revoked" };

export class BridgeRealtimeCoordinator {
  private epoch?: string;
  private wakeIds: string[] = [];

  receive(message: unknown): BridgeRealtimeEvent | undefined {
    const frame = parseBridgeRealtimeServerFrame(message);
    if (!frame) {
      return undefined;
    }
    if (frame.type === "wake") {
      this.wakeIds = [...new Set([...this.wakeIds, ...frame.wakeIds])].slice(
        -maxWakeIds,
      );
      return { reason: "wake", wakeIds: [...this.wakeIds] };
    }
    if (frame.type === "resync") {
      this.epoch = frame.connectionEpoch;
      return { reason: "resync", wakeIds: [...this.wakeIds] };
    }
    if (frame.type === "control") {
      return { controlId: frame.controlId, reason: "control" };
    }
    return { reason: frame.type };
  }

  connectionEpoch() {
    return this.epoch;
  }

  disconnect() {
    this.epoch = undefined;
  }

  pendingWakeIds() {
    return [...this.wakeIds];
  }

  acknowledgeResync(wakeIds?: string[]) {
    const requested = new Set(wakeIds ?? this.wakeIds);
    const acknowledged = this.wakeIds.filter((wakeId) =>
      requested.has(wakeId),
    );
    this.wakeIds = this.wakeIds.filter((wakeId) => !requested.has(wakeId));
    return acknowledged;
  }
}

export type BridgeRealtimeClientOptions = {
  appUrl: string;
  bridgeApiUrl?: string;
  bridgeToken: string;
  deviceId: string;
  fetch?: typeof fetch;
  ticketMetadata?: () => Record<string, unknown>;
  onEvent: (event: BridgeRealtimeEvent) => void | Promise<void>;
  webSocketFactory?: (url: string, protocols: string[]) => WebSocket;
};

type BridgeRealtimeTicketOptions = Pick<
  BridgeRealtimeClientOptions,
  | "appUrl"
  | "bridgeApiUrl"
  | "bridgeToken"
  | "deviceId"
  | "fetch"
  | "ticketMetadata"
>;

export async function issueBridgeDeviceRealtimeTicket(
  options: BridgeRealtimeTicketOptions,
) {
  const nonce = createNonce();
  const nonceHash = await hashNonce(nonce);
  const ticketResponse = await (options.fetch ?? fetch)(
    buildHttpUrl(options, "/api/agent-bridge/realtime/ticket"),
    {
      body: JSON.stringify({
        deviceId: options.deviceId,
        nonceHash,
        ...options.ticketMetadata?.(),
      }),
      headers: {
        authorization: `Bearer ${options.bridgeToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
  const ticket = (await ticketResponse.json().catch(() => null)) as {
    ticketId?: unknown;
  } | null;
  if (!ticketResponse.ok || typeof ticket?.ticketId !== "string") {
    throw new Error(
      `Bridge realtime ticket failed (${ticketResponse.status})`,
    );
  }
  return { nonce, ticketId: ticket.ticketId };
}

export class BridgeDeviceRealtimeClient {
  private readonly coordinator = new BridgeRealtimeCoordinator();
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (
    url: string,
    protocols: string[],
  ) => WebSocket;
  private socket?: WebSocket;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private safetyTimer?: ReturnType<typeof setInterval>;
  private sequence = 0;

  constructor(private readonly options: BridgeRealtimeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, protocols) => new WebSocket(url, protocols));
  }

  async start() {
    this.closed = false;
    if (!this.safetyTimer) {
      this.safetyTimer = setInterval(() => {
        void this.options.onEvent({
          reason: "resync",
          wakeIds: this.coordinator.pendingWakeIds(),
        });
      }, 30_000);
      this.safetyTimer.unref?.();
    }
    await this.connect();
  }

  async close() {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = undefined;
    }
    this.socket?.close(1000, "Bridge stopped");
    this.socket = undefined;
    this.coordinator.disconnect();
  }

  isConnected() {
    return (
      this.socket?.readyState === WebSocket.OPEN &&
      Boolean(this.coordinator.connectionEpoch())
    );
  }

  connectionEpoch() {
    return this.coordinator.connectionEpoch();
  }

  pendingWakeIds() {
    return this.coordinator.pendingWakeIds();
  }

  acknowledgeResync(wakeIds?: string[]) {
    const acknowledgedWakeIds =
      this.coordinator.acknowledgeResync(wakeIds);
    this.send({ type: "resync_complete", wakeIds: acknowledgedWakeIds });
    return acknowledgedWakeIds;
  }

  sendStatus(status: Record<string, unknown>) {
    this.send({ status, type: "status" });
  }

  sendLiveness(liveness: Record<string, unknown>) {
    this.send({ liveness, type: "liveness" });
  }

  acknowledgeControl(
    controlId: string,
    status: "accepted" | "completed" | "failed",
  ) {
    this.send({ controlId, status, type: "control_ack" });
  }

  private async connect() {
    if (this.closed) {
      return;
    }
    try {
      const ticket = await issueBridgeDeviceRealtimeTicket({
        ...this.options,
        fetch: this.fetchImpl,
      });
      const socket = this.webSocketFactory(
        buildWebSocketUrl(this.options.appUrl, this.options.deviceId),
        [bridgeRealtimeProtocol, ticket.ticketId, ticket.nonce],
      );
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
      });
      socket.addEventListener("message", (event) => {
        const parsed = this.coordinator.receive(event.data);
        if (parsed) {
          if (isTerminalBridgeRealtimeEvent(parsed)) {
            void this.close();
          }
          void this.options.onEvent(parsed);
        }
      });
      socket.addEventListener("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.coordinator.disconnect();
        }
        this.scheduleReconnect();
      });
      socket.addEventListener("error", () => socket.close());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = bridgeRealtimeReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(payload: Record<string, unknown>) {
    const connectionEpoch = this.coordinator.connectionEpoch();
    if (!connectionEpoch || this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.sequence += 1;
    this.socket.send(
      JSON.stringify({ connectionEpoch, sequence: this.sequence, ...payload }),
    );
    return true;
  }
}

export function bridgeRealtimeReconnectDelay(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.floor(attempt)));
}

export function isTerminalBridgeRealtimeEvent(event: BridgeRealtimeEvent) {
  return event.reason === "superseded" || event.reason === "revoked";
}

export function parseBridgeRealtimeServerFrame(
  value: unknown,
): BridgeRealtimeServerFrame | undefined {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxFrameBytes
  ) {
    return undefined;
  }
  try {
    const frame = JSON.parse(value) as Record<string, unknown>;
    if (frame.type === "wake" && isWakeIds(frame.wakeIds)) {
      return { type: "wake", wakeIds: frame.wakeIds };
    }
    if (frame.type === "control" && isToken(frame.controlId)) {
      return { controlId: frame.controlId, type: "control" };
    }
    if (
      frame.type === "resync" &&
      isToken(frame.connectionEpoch) &&
      (frame.reason === "connected" || frame.reason === "safety")
    ) {
      return {
        connectionEpoch: frame.connectionEpoch,
        reason: frame.reason,
        type: "resync",
      };
    }
    if (frame.type === "superseded" || frame.type === "revoked") {
      return { type: frame.type };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildHttpUrl(
  options: Pick<BridgeRealtimeClientOptions, "appUrl" | "bridgeApiUrl">,
  path: string,
) {
  return new URL(path, options.bridgeApiUrl ?? options.appUrl).toString();
}

function buildWebSocketUrl(appUrl: string, deviceId: string) {
  const url = new URL(
    `/api/realtime/bridge-devices/${encodeURIComponent(deviceId)}`,
    appUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createNonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

async function hashNonce(nonce: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`bridge-device-realtime-nonce:v1:${nonce}`),
  );
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

function isWakeIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length <= maxWakeIds && value.every(isToken)
  );
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
