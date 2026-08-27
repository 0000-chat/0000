import { describe, expect, it } from "vitest";
import { ApiClient } from "./client";

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
});
