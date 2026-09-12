import { describe, expect, it } from "vitest";
import {
  AuthorizedIdentitySchema,
  ApiErrorResponseSchema,
  ChannelSummarySchema,
  CommandSchema,
  ConnectionSchema,
  ConversationPageResultSchema,
  ConversationSummarySchema,
  DirectoryPrincipalSchema,
  IdentitySchema,
  MessageCreatedDataSchema,
  RealtimeConnectedFrameSchema,
  RealtimeEventSchema,
  RealtimeTicketRequestSchema,
  SessionResponseSchema,
  type ChannelSummary,
} from "../src/index";

describe("directory authorization schemas", () => {
  it("accepts invalid_request and rejects unknown API error codes", () => {
    expect(ApiErrorResponseSchema.safeParse({
      error: { code: "invalid_request", message: "Invalid request" },
    }).success).toBe(true);
    expect(ApiErrorResponseSchema.safeParse({
      error: { code: "internal_error", message: "Invalid request" },
    }).success).toBe(false);
  });

  it("accepts a strict authenticated session response", () => {
    expect(SessionResponseSchema.parse({
      tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot" },
      principal: { id: "principal_human", type: "human", display_name: "Human" },
      membership: { id: "membership_human", role: "owner" },
      identities: [{
        identity_id: "identity_human",
        kind: "human",
        display_name: "Human",
        scopes: ["conversation.read", "message.send"],
      }],
    })).toMatchObject({ identities: [{ identity_id: "identity_human" }] });
  });

  it("rejects scopes outside the public operation enum", () => {
    expect(AuthorizedIdentitySchema.safeParse({
      identity_id: "identity_human",
      kind: "human",
      display_name: "Human",
      scopes: ["root"],
    }).success).toBe(false);
  });

  it("does not expose normalized OIDC subjects in directory principals", () => {
    expect(DirectoryPrincipalSchema.safeParse({
      id: "principal_human",
      issuer: "https://issuer.example/",
      subject: "secret-subject-must-not-be-public",
      type: "human",
      display_name: "Human",
      status: "active",
    }).success).toBe(false);
  });
});

describe("ChannelSummarySchema", () => {
  const channel = {
    id: "connection_human_telegram",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send", "typing.send"],
    unread_count: 3,
    last_activity_at: "2026-08-28T00:03:00.000Z",
    sort_position: 20,
  } satisfies ChannelSummary;

  it("uses the connection id and accepts derived navigation fields", () => {
    expect(ChannelSummarySchema.parse(channel)).toEqual(channel);
  });

  it("accepts a channel with no activity and an attention code", () => {
    expect(ChannelSummarySchema.parse({
      ...channel,
      status: "attention_required",
      last_activity_at: null,
      unread_count: 0,
      attention_code: "reauth_required",
    })).toMatchObject({ status: "attention_required", last_activity_at: null });
  });

  it("rejects negative unread totals and sort positions", () => {
    expect(ChannelSummarySchema.safeParse({ ...channel, unread_count: -1 }).success).toBe(false);
    expect(ChannelSummarySchema.safeParse({ ...channel, sort_position: -1 }).success).toBe(false);
  });
});

describe("ConversationPageResultSchema", () => {
  it("accepts one canonical page shape with an opaque continuation cursor", () => {
    expect(ConversationPageResultSchema.parse({
      items: [],
      next_cursor: "opaque-cursor",
    })).toEqual({ items: [], next_cursor: "opaque-cursor" });
    expect(ConversationPageResultSchema.parse({ items: [], next_cursor: null })).toEqual({
      items: [],
      next_cursor: null,
    });
  });
});

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

  it("requires command and realtime contract identifiers", () => {
    expect(() => CommandSchema.parse({ operation: "message.send" })).toThrow();
    expect(() => RealtimeConnectedFrameSchema.parse({ type: "connected" })).toThrow();
    expect(RealtimeTicketRequestSchema.safeParse({
      schema_version: 1,
      subscriptions: [],
    }).success).toBe(false);
  });

  it("requires conversation ownership by identity and connection", () => {
    expect(ConversationSummarySchema.safeParse({
      id: "conversation_human_one",
      tenant_id: "tenant_pilot",
      title: "Example Contact",
    }).success).toBe(false);
  });
});

describe("MessageCreatedDataSchema", () => {
  it("accepts the scoped message summary used by the inbox", () => {
    expect(MessageCreatedDataSchema.parse({
      last_message_preview: "New reply",
      last_activity_at: "2026-08-28T00:07:00.000Z",
      unread_delta: 1,
    })).toEqual({
      last_message_preview: "New reply",
      last_activity_at: "2026-08-28T00:07:00.000Z",
      unread_delta: 1,
    });
  });

  it("rejects unknown fields", () => {
    expect(MessageCreatedDataSchema.safeParse({
      last_message_preview: "New reply",
      last_activity_at: "2026-08-28T00:07:00.000Z",
      unread_delta: 1,
      message_body: "not part of the inbox summary",
    }).success).toBe(false);
  });
});
