import {
  createPlatformGuestClient,
  createPlatformClient,
} from "@0000/platform-client";
import type { GuestGrantAssertion, GuestGrantResult } from "@0000/contracts";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUEST_PERMISSION_ID,
  parseGuestAssertion,
} from "../../src/guest-state";
import { opaqueSecret } from "../../src/platform-state";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;

function service(): TestService {
  return {
    serviceId: `guest-permission-${crypto.randomUUID()}`,
    audience: `https://guest-permission-${crypto.randomUUID()}.0000.test`,
    verifier: opaqueSecret("service_verify_"),
    guestGrantIssuer: opaqueSecret("service_guest_grant_"),
    allowedCapabilities: ["resource:read"],
  };
}

function guestClient(registration: TestService) {
  return createPlatformGuestClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: registration.audience,
    guestGrantIssuer: registration.guestGrantIssuer,
    fetch: (input, init) => SELF.fetch(input, init),
  });
}

function platformClient(registration: TestService) {
  return createPlatformClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: registration.audience,
    serviceVerifier: registration.verifier,
    fetch: (input, init) => SELF.fetch(input, init),
  });
}

function ownerAssertion(
  guestId: string,
  permissionId: string,
): GuestGrantAssertion {
  return {
    kind: "owner",
    storedOwnerId: guestId,
    permissionId,
  };
}

function successfulGrant(result: GuestGrantResult) {
  if (result.status !== "success") {
    throw new Error(`Expected guest grant success, got ${result.status}`);
  }
  return result.value;
}

async function grant(
  client: ReturnType<typeof guestClient>,
  guestId: string,
  bootstrapCredential: string,
  resourceId: string,
  permissionId?: string,
) {
  return client.attestGuestGrant({
    bootstrapCredential,
    resourceId,
    capabilities: ["resource:read"],
    assertion:
      permissionId === undefined
        ? { kind: "owner", storedOwnerId: guestId }
        : ownerAssertion(guestId, permissionId),
  });
}

describe("guest permission grants", () => {
  it("supports independent same-resource permissions", async () => {
    const registration = service();
    await registerTestService(testEnv.IDENTITY_DB, registration);
    const client = guestClient(registration);
    const guest = await client.createGuest();
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const resourceId = `resource-shared-${crypto.randomUUID()}`;
    const owner = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "owner",
      ),
    );
    const publicGrant = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "public",
      ),
    );
    const managementGrant = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "management",
      ),
    );
    expect(
      new Set([owner.grantId, publicGrant.grantId, managementGrant.grantId]),
    ).toHaveLength(3);
    const stored = await testEnv.IDENTITY_DB.prepare(
      `SELECT permission_id FROM platform_guest_grant
       WHERE guest_id = ? AND service_id = ? AND resource_id = ?
       ORDER BY permission_id`,
    )
      .bind(guest.guestId, registration.serviceId, resourceId)
      .all<{ permission_id: string }>();
    expect(stored.results.map((row) => row.permission_id)).toEqual([
      "management",
      "owner",
      "public",
    ]);

    const platform = platformClient(registration);
    expect((await platform.authenticate(owner.credential)).status).toBe(
      "authenticated",
    );
    expect((await platform.authenticate(publicGrant.credential)).status).toBe(
      "authenticated",
    );
    expect(
      (await platform.authenticate(managementGrant.credential)).status,
    ).toBe("authenticated");

    expect(await client.revokeGuestGrant(publicGrant.grantId)).toEqual({
      status: "success",
      revoked: true,
    });
    expect((await platform.authenticate(publicGrant.credential)).status).toBe(
      "invalid_credential",
    );
    expect((await platform.authenticate(owner.credential)).status).toBe(
      "authenticated",
    );
    expect(
      (await platform.authenticate(managementGrant.credential)).status,
    ).toBe("authenticated");

    expect(
      await client.renewGuestGrant({
        grantId: owner.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId,
        capabilities: ["resource:read"],
        assertion: ownerAssertion(guest.guestId, "public"),
      }),
    ).toEqual({ status: "grant_denied" });
    expect(
      await client.renewGuestGrant({
        grantId: owner.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId,
        capabilities: ["resource:write"],
        assertion: ownerAssertion(guest.guestId, "owner"),
      }),
    ).toEqual({ status: "grant_denied" });
    const renewedOwner = successfulGrant(
      await client.renewGuestGrant({
        grantId: owner.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId,
        capabilities: ["resource:read"],
        assertion: ownerAssertion(guest.guestId, "owner"),
      }),
    );
    expect(renewedOwner.grantId).toBe(owner.grantId);
    expect((await platform.authenticate(owner.credential)).status).toBe(
      "invalid_credential",
    );
    expect((await platform.authenticate(renewedOwner.credential)).status).toBe(
      "authenticated",
    );

    expect(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "management",
      ),
    ).toEqual({ status: "conflict" });

    const concurrentPermission = `concurrent-${crypto.randomUUID()}`;
    const concurrent = await Promise.all([
      grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        concurrentPermission,
      ),
      grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        concurrentPermission,
      ),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([
      "conflict",
      "success",
    ]);
  });

  it("normalizes default permission callers and rejects malformed permission ids", async () => {
    expect(parseGuestAssertion({ kind: "participant" })).toEqual({
      kind: "participant",
      permissionId: DEFAULT_GUEST_PERMISSION_ID,
    });
    expect(
      parseGuestAssertion({ kind: "participant", permissionId: null }),
    ).toBeNull();
    expect(
      parseGuestAssertion({ kind: "participant", permissionId: "" }),
    ).toBeNull();
    expect(
      parseGuestAssertion({
        kind: "participant",
        permissionId: "x".repeat(513),
      }),
    ).toBeNull();
    expect(
      parseGuestAssertion({ kind: "participant", permissionId: 42 }),
    ).toBeNull();
    expect(
      parseGuestAssertion({ kind: "participant", permissionId: undefined }),
    ).toBeNull();
    expect(
      parseGuestAssertion({ kind: "participant", permissionId: "bad\u0000id" }),
    ).toBeNull();

    const registration = service();
    await registerTestService(testEnv.IDENTITY_DB, registration);
    const client = guestClient(registration);
    const guest = await client.createGuest();
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;
    const resourceId = `resource-default-${crypto.randomUUID()}`;
    const created = successfulGrant(
      await grant(client, guest.guestId, guest.bootstrapCredential, resourceId),
    );
    const stored = await testEnv.IDENTITY_DB.prepare(
      "SELECT permission_id FROM platform_guest_grant WHERE id = ?",
    )
      .bind(created.grantId)
      .first<{ permission_id: string }>();
    expect(stored?.permission_id).toBe(DEFAULT_GUEST_PERMISSION_ID);
    const renewed = successfulGrant(
      await client.renewGuestGrant({
        grantId: created.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId,
        capabilities: ["resource:read"],
        assertion: { kind: "owner", storedOwnerId: guest.guestId },
      }),
    );
    expect(renewed.grantId).toBe(created.grantId);

    const invalidValues: unknown[] = [
      null,
      "",
      "x".repeat(513),
      42,
      { opaque: "nested" },
    ];
    for (const [index, permissionId] of invalidValues.entries()) {
      const response = await SELF.fetch(
        "http://localhost/internal/v1/guest-grants",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${registration.guestGrantIssuer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            bootstrapCredential: guest.bootstrapCredential,
            resourceId: `resource-invalid-${index}-${crypto.randomUUID()}`,
            capabilities: ["resource:read"],
            assertion: {
              kind: "owner",
              storedOwnerId: guest.guestId,
              permissionId,
            },
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("keeps permission authority immutable in D1", async () => {
    const registration = service();
    await registerTestService(testEnv.IDENTITY_DB, registration);
    const client = guestClient(registration);
    const guest = await client.createGuest();
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;
    const created = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        `resource-immutable-${crypto.randomUUID()}`,
        "owner",
      ),
    );
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_guest_grant SET permission_id = ? WHERE id = ?",
      )
        .bind("changed", created.grantId)
        .run(),
    ).rejects.toThrow("guest grant authority is immutable");
    const current = await testEnv.IDENTITY_DB.prepare(
      "SELECT permission_id FROM platform_guest_grant WHERE id = ?",
    )
      .bind(created.grantId)
      .first<{ permission_id: string }>();
    expect(current?.permission_id).toBe("owner");
  });
});
