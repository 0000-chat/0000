import type { RealtimeEvent } from "@communicator/contracts";

export type RealtimeListener = (event: RealtimeEvent) => void;

export interface RealtimeClient {
  connect(): Promise<void>;
  subscribe(listener: RealtimeListener): () => void;
  readonly lastSequence: number;
  close(): void;
}
