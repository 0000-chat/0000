import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, isDefinitiveRequestRejection } from "./client";

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

  it("accepts opaque tenant and principal IDs with variable identity counts", async () => {
    const responses = [
      {
        tenant_id: "tenant_other",
        principal_id: "principal_other",
        display_name: "Other operator",
        authorized_identity_ids: ["identity_other"],
      },
      {
        tenant_id: "tenant_shared",
        principal_id: "principal_shared",
        display_name: "Shared operator",
        authorized_identity_ids: ["identity_one", "identity_two", "identity_three"],
      },
    ];
    const client = new ApiClient(async () => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(client.getMe()).resolves.toMatchObject({
      tenant_id: "tenant_other",
      principal_id: "principal_other",
      authorized_identity_ids: ["identity_other"],
    });
    await expect(client.getMe()).resolves.toMatchObject({
      tenant_id: "tenant_shared",
      principal_id: "principal_shared",
      authorized_identity_ids: ["identity_one", "identity_two", "identity_three"],
    });
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
