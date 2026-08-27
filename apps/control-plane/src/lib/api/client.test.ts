import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, isDefinitiveRequestRejection } from "./client";

describe("Communicator API client", () => {
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
