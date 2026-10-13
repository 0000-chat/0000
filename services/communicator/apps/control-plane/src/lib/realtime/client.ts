import type {
  RealtimeEvent,
  RealtimeServerFrame,
} from "@communicator/contracts";

export type RealtimeConnectOptions = {
  tenantId: string;
  principalId: string;
  identityIds: readonly string[];
  families: readonly ["projection"];
};

export type RealtimeClientEvent = RealtimeEvent | RealtimeServerFrame;
export type RealtimeListener = (event: RealtimeClientEvent) => void;
export type RealtimeLegacyListener = (event: RealtimeEvent) => void;

export type RealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unauthorized"
  | "unavailable";

export type RealtimeStatusListener = (status: RealtimeStatus) => void;

export interface RealtimeClient {
  connect(options: RealtimeConnectOptions): Promise<void>;
  subscribe(listener: RealtimeLegacyListener): () => void;
  subscribe(listener: RealtimeListener): () => void;
  subscribeStatus(listener: RealtimeStatusListener): () => void;
  readonly status: RealtimeStatus;
  readonly lastSequence: number;
  close(): void;
  reset(): void;
}
