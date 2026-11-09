import {
  createPlatformClient,
  createPlatformGuestClient,
} from "@0000/platform-client";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issueHumanCredential, hashOpaque } from "../../src/platform-state";
import {
  createAgent,
  createOrNarrowAgentGrant,
  issueAgentCredential,
} from "../../src/agent-state";
import {
  registerService,
  registerGuestIssuer,
} from "../../src/service-registration";
import { provisionSavedAgent } from "./fixtures/saved-agent";

const testEnv = env as Cloudflare.Env;

async function fixture() {
  const suffix = crypto.randomUUID();
  const provisioned = await registerService(testEnv.IDENTITY_DB, {
    serviceId: `saved-${suffix}`,
    audience: `https://saved-${suffix}.example.test`,
    capabilities: ["resource:read", "resource:write"],
  });
  const service = {
    ...provisioned,
    allowedCapabilities: provisioned.capabilities,
    verifierHash: await hashOpaque(provisioned.verifier),
  };
  const actor = await provisionSavedAgent(testEnv.IDENTITY_DB, service);
  const client = createPlatformClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch: SELF.fetch,
  });
  const input = {
    credential: actor.credential,
    operationId: `job-${suffix}`,
    capability: "resource:read",
  };
  return { service, actor, client, input };
}

describe("saved operation current authority", () => {
  it("makes lost-response and concurrent captures idempotent without permitting rebinding", async () => {
    const { service, actor, client, input } = await fixture();
    const interrupted = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: async (url, init) => {
        const committed = await SELF.fetch(url, init);
        expect(committed.status).toBe(200);
        await committed.arrayBuffer();
        throw new Error("simulated response loss after commit");
      },
    });
    expect(await interrupted.captureSavedOperation(input)).toEqual({
      status: "authority_unavailable",
    });
    const committed = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM platform_saved_operation WHERE service_id = ? AND operation_id = ?",
    )
      .bind(service.serviceId, input.operationId)
      .first<{ id: string }>();
    const results = await Promise.all([
      client.captureSavedOperation(input),
      client.captureSavedOperation(input),
    ]);
    const captured = results[0]!;
    expect(captured.status).toBe("allowed");
    expect(results[1]).toEqual(captured);
    expect(await client.captureSavedOperation(input)).toEqual(captured);
    if (captured.status !== "allowed") throw new Error("capture failed");
    expect(captured.authorization.id).toBe(committed?.id);
    expect(
      (await client.revalidateSavedOperation(captured.authorization)).status,
    ).toBe("allowed");
    expect(
      await client.captureSavedOperation({
        ...input,
        capability: "resource:write",
      }),
    ).toEqual({ status: "denied" });
    const other = await provisionSavedAgent(testEnv.IDENTITY_DB, service);
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: other.credential,
      }),
    ).toEqual({ status: "denied" });

    for (const field of [
      "id",
      "authority",
      "subjectId",
      "organizationId",
      "audience",
      "operationId",
      "capability",
    ] as const) {
      // Exercise the server directly: client-side audience checks alone are insufficient.
      const response = await SELF.fetch(
        "http://localhost/internal/v1/saved-operations/revalidate",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${service.verifier}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...captured.authorization,
            [field]:
              field === "capability"
                ? "resource:write"
                : `${captured.authorization[field]}-forged`,
          }),
        },
      );
      expect(response.status, field).toBe(403);
      expect(await response.json()).toEqual({ status: "denied" });
    }
    const otherService = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `other-${crypto.randomUUID()}`,
      audience: "https://other-saved.example.test",
      capabilities: ["resource:read"],
    });
    const wrongService = await SELF.fetch(
      "http://localhost/internal/v1/saved-operations/revalidate",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${otherService.verifier}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...captured.authorization,
          audience: otherService.audience,
        }),
      },
    );
    expect(wrongService.status).toBe(403);
    expect(
      (
        await createPlatformClient({
          baseUrl: testEnv.PLATFORM_BASE_URL,
          authority: testEnv.PLATFORM_AUTHORITY_ID,
          audience: otherService.audience,
          serviceVerifier: otherService.verifier,
          fetch: SELF.fetch,
        }).captureSavedOperation(input)
      ).status,
    ).toBe("denied");
    const row = await testEnv.IDENTITY_DB.prepare(
      "SELECT * FROM platform_saved_operation WHERE id = ?",
    )
      .bind(captured.authorization.id)
      .first();
    expect(row).toMatchObject({
      credential_id: actor.credentialId,
      lineage_kind: "grant",
      lineage_id: actor.grantId,
    });
    expect(JSON.stringify(row)).not.toContain(actor.credential);
    expect(JSON.stringify(row)).not.toContain(
      await hashOpaque(actor.credential),
    );
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_saved_operation SET capability = 'resource:write' WHERE id = ?",
      )
        .bind(captured.authorization.id)
        .run(),
    ).rejects.toThrow("immutable");
    const count = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_saved_operation WHERE service_id = ? AND operation_id = ?",
    )
      .bind(service.serviceId, input.operationId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it.each([
    "grant",
    "credential",
    "expiry",
    "catalog",
    "organization",
    "actor",
  ] as const)(
    "denies saved work after native %s invalidation",
    async (change) => {
      const { actor, client, service, input } = await fixture();
      const captured = await client.captureSavedOperation(input);
      if (captured.status !== "allowed") throw new Error("capture failed");
      expect(
        (await client.revalidateSavedOperation(captured.authorization)).status,
      ).toBe("allowed");
      const mutations = {
        grant: testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_agent_grant SET revoked_at = ? WHERE id = ?",
        ).bind(Date.now(), actor.grantId),
        credential: testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_credential SET revoked_at = ? WHERE id = ?",
        ).bind(Date.now(), actor.credentialId),
        expiry: testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_credential SET expires_at = ? WHERE id = ?",
        ).bind(Date.now() - 1, actor.credentialId),
        catalog: testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_service SET allowed_capabilities = '[\"resource:write\"]' WHERE service_id = ?",
        ).bind(service.serviceId),
        organization: testEnv.IDENTITY_DB.prepare(
          "UPDATE organization SET suspendedAt = ? WHERE id = ?",
        ).bind(Date.now(), actor.organizationId),
        actor: testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_agent SET enabled = 0 WHERE id = ?",
        ).bind(actor.agentId),
      };
      await mutations[change].run();
      expect(
        await client.revalidateSavedOperation(captured.authorization),
      ).toEqual({ status: "denied" });
      expect(await client.captureSavedOperation(input)).toEqual({
        status: "denied",
      });
      const liveService = await testEnv.IDENTITY_DB.prepare(
        "SELECT disabled FROM platform_service WHERE service_id = ?",
      )
        .bind(service.serviceId)
        .first<{ disabled: number }>();
      expect(liveService?.disabled).toBe(0);
    },
  );

  it("distinguishes actual D1 authority loss and invalid verifier from actor denial", async () => {
    const { client, input, service } = await fixture();
    const captured = await client.captureSavedOperation(input);
    if (captured.status !== "allowed") throw new Error("capture failed");
    const invalidVerifier = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: "not-a-service",
      fetch: SELF.fetch,
    });
    expect(
      await invalidVerifier.revalidateSavedOperation(captured.authorization),
    ).toEqual({ status: "authority_unavailable" });
    await testEnv.IDENTITY_DB.prepare(
      "DROP TABLE platform_saved_operation",
    ).run();
    expect(
      await client.revalidateSavedOperation(captured.authorization),
    ).toEqual({ status: "authority_unavailable" });
    expect(await client.captureSavedOperation(input)).toEqual({
      status: "authority_unavailable",
    });
  });

  it("denies unlineaged human keys, service actors, guest controls and bare identifiers", async () => {
    const { client, input, actor, service } = await fixture();
    const human = await issueHumanCredential(testEnv.IDENTITY_DB, {
      userId: actor.userId,
      service,
      organizationId: actor.organizationId,
      membershipId: actor.membershipId,
      capabilities: ["resource:read"],
      expiresAt: Date.now() + 60_000,
    });
    expect((await client.authenticate(human.credential)).status).toBe(
      "authenticated",
    );
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: human.credential,
      }),
    ).toEqual({ status: "denied" });
    const machine = await createAgent(testEnv.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      name: "scheduler",
      kind: "service",
    });
    if (!machine) throw new Error("service fixture failed");
    const grant = await createOrNarrowAgentGrant(
      testEnv.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        agentId: machine.id,
        service,
        capabilities: ["resource:read"],
        kind: "service",
      },
    );
    if (grant.status !== "created")
      throw new Error("service grant fixture failed");
    const scheduler = await issueAgentCredential(testEnv.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      agentId: machine.id,
      grantId: grant.grant.id,
      service,
      capabilities: ["resource:read"],
      expiresAt: Date.now() + 60_000,
      kind: "service",
    });
    expect((await client.authenticate(scheduler.credential)).status).toBe(
      "authenticated",
    );
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: scheduler.credential,
      }),
    ).toEqual({ status: "denied" });
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: actor.agentId,
      }),
    ).toEqual({ status: "denied" });
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: actor.credentialId,
      }),
    ).toEqual({ status: "denied" });
    const issuer = await registerGuestIssuer(
      testEnv.IDENTITY_DB,
      service.serviceId,
    );
    const guestClient = createPlatformGuestClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      guestGrantIssuer: issuer.guestGrantIssuer,
      fetch: SELF.fetch,
    });
    const guest = await guestClient.createGuest();
    if (guest.status !== "success") throw new Error("guest fixture failed");
    const guestGrant = await guestClient.attestGuestGrant({
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "saved-guest-fixture",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    if (guestGrant.status !== "success")
      throw new Error("guest grant fixture failed");
    expect(
      (await client.authenticate(guestGrant.value.credential)).status,
    ).toBe("authenticated");
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: guestGrant.value.credential,
      }),
    ).toEqual({ status: "denied" });
    expect(
      await client.captureSavedOperation({
        ...input,
        credential: guest.bootstrapCredential,
      }),
    ).toEqual({ status: "denied" });
  });
});
