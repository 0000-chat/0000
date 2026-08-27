import { describe, expect, it } from "vitest";
import {
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  RealtimeEventSchema,
} from "../src/index";

describe("public schemas", () => {
  it("accepts opaque Communicator IDs and rejects Matrix IDs", () => {
    expect(IdentitySchema.safeParse({
      id: "identity_human",
      tenant_id: "tenant_pilot",
      kind: "human",
      display_name: "Human",
    }).success).toBe(true);
    expect(IdentitySchema.safeParse({
      id: "@human:communicator.0000.gold",
      tenant_id: "tenant_pilot",
      kind: "human",
      display_name: "Human",
    }).success).toBe(false);
  });

  it("keeps connection capabilities data-driven", () => {
    const parsed = ConnectionSchema.parse({
      id: "connection_human_whatsapp",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      provider: "whatsapp",
      display_label: "Personal WhatsApp",
      status: "ready",
      capabilities: ["message.send", "reaction.add", "typing.send"],
      last_synced_at: "2026-08-27T00:00:00.000Z",
    });
    expect(parsed.capabilities).toContain("typing.send");
  });

  it("requires command and realtime sequence identifiers", () => {
    expect(() => CommandSchema.parse({ operation: "message.send" })).toThrow();
    expect(() => RealtimeEventSchema.parse({ type: "command.updated" })).toThrow();
  });

  it("requires conversation ownership by identity and connection", () => {
    expect(ConversationSummarySchema.safeParse({
      id: "conversation_human_one",
      tenant_id: "tenant_pilot",
      title: "Example Contact",
    }).success).toBe(false);
  });
});
