import {
  RealtimeEventSchema,
  type Command,
  type CommandStatus,
} from "@communicator/contracts";
import type { RealtimeClient, RealtimeListener } from "./client";

export type SimulatedClock = () => Date;

export class SimulatedRealtimeClient implements RealtimeClient {
  private listeners = new Set<RealtimeListener>();
  private sequence = 0;
  private connected = false;

  constructor(private readonly clock: SimulatedClock = () => new Date()) {}

  get lastSequence() {
    return this.sequence;
  }

  async connect() {
    this.connected = true;
  }

  subscribe(listener: RealtimeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishCommand(command: Command, statuses: CommandStatus[] = ["accepted"]) {
    if (!this.connected) return;
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
    if (!this.connected) return;
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
    this.listeners.clear();
  }

  reset() {
    this.sequence = 0;
  }
}
