import { describe, expect, it } from "vitest";
import {
  SessionResponseSchema,
  type MessagePageResult,
  type SessionResponse,
} from "@communicator/contracts";
import {
  ApiClient,
  ApiError,
  identitiesFromSession,
  isDefinitiveRequestRejection,
} from "./client";

const session: SessionResponse = {
  tenant: {
    id: "tenant_pilot",
    slug: "pilot",
    display_name: "Pilot tenant",
  },
  principal: {
    id: "principal_pilot",
    type: "operator",
    display_name: "Pilot operator",
  },
  membership: {
    id: "membership_pilot",
    role: "admin",
  },
  identities: [
    {
      identity_id: "identity_human",
      kind: "human",
      display_name: "Human",
      scopes: ["conversation.read", "connection.read"],
    },
    {
      identity_id: "identity_agent",
      kind: "agent",
      display_name: "Agent",
      scopes: ["conversation.read", "connection.read"],
    },
  ],
};

describe("Communicator API client", () => {
  it("encodes identity and channel IDs in scoped channel queries", async () => {
    const urls: string[] = [];
    const client = new ApiClient(async (input) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith("/channels")
        ? []
        : { items: [], next_cursor: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }, "https://communicator.test");

    await client.getChannels("identity/a");
    await client.getConversations("identity/a", "connection?a=b");

    expect(urls).toEqual([
      "https://communicator.test/api/v1/identities/identity%2Fa/channels",
      "https://communicator.test/api/v1/identities/identity%2Fa/conversations?limit=50&channel_id=connection%3Fa%3Db",
    ]);
  });

  it("turns an invalid channel response into a bad gateway error", async () => {
    const client = new ApiClient(async () => new Response(JSON.stringify([{
      id: "connection_human_telegram",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      provider: "telegram",
      display_label: "Telegram",
      status: "ready",
      capabilities: ["message.send"],
      unread_count: -1,
      last_activity_at: null,
      sort_position: 20,
    }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(client.getChannels("identity_human"))
      .rejects.toMatchObject({ name: "ApiError", status: 502 });
  });

  it("rejects navigation collections that exceed the hard response bound", async () => {
    const channel = {
      id: "connection_human_telegram",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      provider: "telegram",
      display_label: "Telegram",
      status: "ready",
      capabilities: ["message.send"],
      unread_count: 0,
      last_activity_at: null,
      sort_position: 20,
    };
    const client = new ApiClient(async () => new Response(JSON.stringify(
      Array.from({ length: 65 }, (_, index) => ({
        ...channel,
        id: `connection_human_telegram_${index}`,
      })),
    ), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(client.getChannels("identity_human"))
      .rejects.toMatchObject({ name: "ApiError", status: 502 });
  });

  it("loads the session contract and derives authorized identities with its tenant", async () => {
    const urls: string[] = [];
    const client = new ApiClient(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }, "https://communicator.test");

    await expect(client.getSession()).resolves.toEqual(session);
    expect(SessionResponseSchema.parse(session)).toEqual(session);
    expect(identitiesFromSession(session)).toEqual([
      {
        id: "identity_human",
        tenant_id: "tenant_pilot",
        kind: "human",
        display_name: "Human",
      },
      {
        id: "identity_agent",
        tenant_id: "tenant_pilot",
        kind: "agent",
        display_name: "Agent",
      },
    ]);
    expect(urls).toEqual(["https://communicator.test/api/v1/session"]);
  });

  it("requests one encoded message page and preserves the shared page shape", async () => {
    const urls: string[] = [];
    const page: MessagePageResult = { items: [], next_cursor: "next cursor/?" };
    const client = new ApiClient(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }, "https://communicator.test");

    await expect(client.getMessages("conversation/a", "identity/a", "cursor /?&", 2))
      .resolves.toEqual(page);
    expect(urls).toEqual([
      "https://communicator.test/api/v1/conversations/conversation%2Fa/messages?identity_id=identity%2Fa&limit=2&cursor=cursor+%2F%3F%26",
    ]);
    const parsed = new URL(urls[0]!);
    expect(parsed.searchParams.getAll("identity_id")).toHaveLength(1);
    expect(parsed.searchParams.getAll("limit")).toHaveLength(1);
    expect(parsed.searchParams.getAll("cursor")).toHaveLength(1);
  });

  it("turns malformed successful response bodies into a generic bad gateway error", async () => {
    const privateResponseDetail = "private response detail";
    const client = new ApiClient(async () => new Response(JSON.stringify({
      items: [{ body: privateResponseDetail }],
      next_cursor: null,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(client.getMessages("conversation_one", "identity_human"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof ApiError
        && error.status === 502
        && !error.message.includes(privateResponseDetail));
  });

  it("only treats definitive client rejections as safe to forget", () => {
    expect(isDefinitiveRequestRejection(new ApiError(400, "bad request"))).toBe(true);
    expect(isDefinitiveRequestRejection(new ApiError(404, "not found"))).toBe(true);
    expect(isDefinitiveRequestRejection(new ApiError(408, "timeout"))).toBe(false);
    expect(isDefinitiveRequestRejection(new ApiError(429, "rate limited"))).toBe(false);
    expect(isDefinitiveRequestRejection(new ApiError(503, "server error"))).toBe(false);
    expect(isDefinitiveRequestRejection(new TypeError("network failure"))).toBe(false);
  });
});
