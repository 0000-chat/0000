import {
  RealtimeEventSchema,
  type Command,
  type CommandStatus,
} from "@communicator/contracts";
import type {
  RealtimeClient,
  RealtimeConnectOptions,
  RealtimeLegacyListener,
  RealtimeListener,
  RealtimeStatus,
  RealtimeStatusListener,
} from "./client";

export type SimulatedClock = () => Date;

export class SimulatedRealtimeClient implements RealtimeClient {
  private listeners = new Set<RealtimeListener>();
  private statusListeners = new Set<RealtimeStatusListener>();
  private sequence = 0;
  private connected = false;
  private statusValue: RealtimeStatus = "idle";
  private requestedTenantId: string | undefined;
  private requestedIdentityIds: Set<string> | undefined;

  constructor(private readonly clock: SimulatedClock = () => new Date()) {}

  get lastSequence() {
    return this.sequence;
  }

  get status() {
    return this.statusValue;
  }

  async connect(options?: RealtimeConnectOptions) {
    if (options) {
      this.requestedTenantId = options.tenantId;
      this.requestedIdentityIds = new Set(options.identityIds);
    } else {
      this.requestedTenantId = undefined;
      this.requestedIdentityIds = undefined;
    }
    this.setStatus("connecting");
    this.connected = true;
    this.setStatus("connected");
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

  publishCommand(command: Command, statuses: CommandStatus[] = ["accepted"]) {
    if (
      !this.connected ||
      !this.isRequested(command.tenant_id, command.identity_id)
    )
      return;
    for (const status of statuses) {
      const event = RealtimeEventSchema.parse({
        sequence: ++this.sequence,
        type: "command.updated",
        tenant_id: command.tenant_id,
        identity_id: command.identity_id,
        occurred_at: this.clock().toISOString(),
        data: {
          command_id: command.id,
          conversation_id: command.conversation_id,
          status,
          delivery_mode: command.delivery_mode,
        },
      });
      for (const listener of this.listeners) listener(event);
    }
  }

  publishMessage(input: {
    tenantId: string;
    identityId: string;
    connectionId: string;
    conversationId: string;
    lastMessagePreview: string;
    lastActivityAt: string;
    unreadDelta: number;
  }) {
    if (!this.connected || !this.isRequested(input.tenantId, input.identityId))
      return;
    const event = RealtimeEventSchema.parse({
      sequence: ++this.sequence,
      type: "message.created",
      tenant_id: input.tenantId,
      identity_id: input.identityId,
      connection_id: input.connectionId,
      conversation_id: input.conversationId,
      occurred_at: input.lastActivityAt,
      data: {
        last_message_preview: input.lastMessagePreview,
        last_activity_at: input.lastActivityAt,
        unread_delta: input.unreadDelta,
      },
    });
    for (const listener of this.listeners) listener(event);
  }

  close() {
    this.connected = false;
    this.requestedTenantId = undefined;
    this.requestedIdentityIds = undefined;
    this.setStatus("idle");
    this.listeners.clear();
  }

  reset() {
    this.sequence = 0;
  }

  private isRequested(tenantId: string, identityId: string) {
    return (
      (!this.requestedTenantId || this.requestedTenantId === tenantId) &&
      (!this.requestedIdentityIds || this.requestedIdentityIds.has(identityId))
    );
  }

  private setStatus(status: RealtimeStatus) {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
