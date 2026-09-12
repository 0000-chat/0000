import type {
  ProjectionConnectionBinding,
  ProjectionEventEnvelope,
} from "@communicator/contracts";

/** Values handed from asynchronous preflight into the synchronous projection transaction. */
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
