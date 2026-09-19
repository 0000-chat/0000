import {
  createPlatformGuestClient,
  createPlatformClient,
} from "@0000/platform-client";
import type { GuestGrantAssertion, GuestGrantResult } from "@0000/contracts";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations, SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUEST_PERMISSION_ID,
  parseGuestAssertion,
} from "../../src/guest-state";
import { hashOpaque, opaqueSecret } from "../../src/platform-state";
import { registerTestService, type TestService } from "./fixtures/provision";

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

const testEnv = env as TestEnv;

function service(allowedCapabilities = ["resource:read"]): TestService {
  return {
    serviceId: `guest-permission-${crypto.randomUUID()}`,
    audience: `https://guest-permission-${crypto.randomUUID()}.0000.test`,
    verifier: opaqueSecret("service_verify_"),
    guestGrantIssuer: opaqueSecret("service_guest_grant_"),
    allowedCapabilities,
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
  options: {
    assertion?: GuestGrantAssertion;
    capabilities?: string[];
  } = {},
) {
  return client.attestGuestGrant({
    bootstrapCredential,
    resourceId,
    capabilities: options.capabilities ?? ["resource:read"],
    assertion:
      options.assertion ??
      (permissionId === undefined
        ? { kind: "owner", storedOwnerId: guestId }
        : ownerAssertion(guestId, permissionId)),
  });
}

function migration(name: string): D1Migration {
  const found = testEnv.TEST_MIGRATIONS.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing migration ${name}`);
  return found;
}

type ExistingGuestGrant = {
  id: string;
  guest_id: string;
  service_id: string;
  audience: string;
  resource_id: string;
  assertion_kind: string;
  permission_id: string;
  capabilities: string;
  created_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
};

const guestGrantObjects = [
  "platform_guest_grant_guest_idx",
  "platform_guest_grant_service_idx",
  "platform_guest_grant_current_resource_unique",
  "platform_guest_grant_current_permission_unique",
  "platform_guest_grant_authority_immutable",
  "platform_guest_grant_service_match_insert",
  "platform_guest_grant_service_match_update",
  "platform_guest_grant_permission_valid_insert",
  "platform_guest_grant_permission_valid_update",
] as const;

async function dropGuestGrantObjects(database: D1Database) {
  await database.batch(
    guestGrantObjects.map((name) =>
      name.includes("unique") || name.endsWith("_idx")
        ? database.prepare(`DROP INDEX IF EXISTS ${name}`)
        : database.prepare(`DROP TRIGGER IF EXISTS ${name}`),
    ),
  );
}

async function hasGuestGrantPermissionColumn(
  database: D1Database,
): Promise<boolean> {
  const columns = await database
    .prepare("PRAGMA table_info(platform_guest_grant)")
    .all<{ name: string }>();
  return columns.results.some((column) => column.name === "permission_id");
}

async function restoreGuestGrantTable(
  database: D1Database,
  backupTable: string,
  migrationTable: string,
  originalRows: ExistingGuestGrant[],
  temporaryGrantId: string,
  temporaryCredentialIds: string[],
): Promise<void> {
  if (!(await hasGuestGrantPermissionColumn(database))) {
    await applyD1Migrations(
      database,
      [migration("0009_guest_permission_grants.sql")],
      migrationTable,
    );
  }
  await database
    .prepare("DELETE FROM platform_credential WHERE id IN (?, ?)")
    .bind(...temporaryCredentialIds)
    .run();
  await database
    .prepare("DELETE FROM platform_guest_grant WHERE id = ?")
    .bind(temporaryGrantId)
    .run();
  if (originalRows.length > 0) {
    await database.batch(
      originalRows.map((row) =>
        database
          .prepare(
            `INSERT INTO platform_guest_grant
             (id, guest_id, service_id, audience, resource_id, assertion_kind,
              permission_id, capabilities, created_at, revoked_at, revoked_reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.guest_id,
            row.service_id,
            row.audience,
            row.resource_id,
            row.assertion_kind,
            row.permission_id,
            row.capabilities,
            row.created_at,
            row.revoked_at,
            row.revoked_reason,
          ),
      ),
    );
  }
  await database.prepare(`DROP TABLE IF EXISTS ${backupTable}`).run();
  await database.prepare(`DROP TABLE IF EXISTS ${migrationTable}`).run();
}

describe("guest permission grants", () => {
  it("upgrades a live pre-0009 default grant before authenticating and renewing it", async () => {
    const registration = service();
    await registerTestService(testEnv.IDENTITY_DB, registration);
    const client = guestClient(registration);
    const guest = await client.createGuest();
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const originalRows = (
      await testEnv.IDENTITY_DB.prepare(
        `SELECT id, guest_id, service_id, audience, resource_id,
                assertion_kind, permission_id, capabilities, created_at,
                revoked_at, revoked_reason
         FROM platform_guest_grant`,
      ).all<ExistingGuestGrant>()
    ).results;
    const backupTable = "platform_guest_grant_pre0009_backup";
    const migrationTable = "guest_permission_upgrade_migrations";
    const resourceId = `resource-pre0009-${crypto.randomUUID()}`;
    const grantId = `grant-pre0009-${crypto.randomUUID()}`;
    const credentialId = `credential-pre0009-${crypto.randomUUID()}`;
    const credential = opaqueSecret("guest_grant_");
    let renewedCredentialId = credentialId;
    let tableMoved = false;

    try {
      await testEnv.IDENTITY_DB.prepare(
        `DROP TABLE IF EXISTS ${backupTable}`,
      ).run();
      await testEnv.IDENTITY_DB.prepare(
        `DROP TABLE IF EXISTS ${migrationTable}`,
      ).run();
      await dropGuestGrantObjects(testEnv.IDENTITY_DB);
      await testEnv.IDENTITY_DB.prepare(
        `ALTER TABLE platform_guest_grant RENAME TO ${backupTable}`,
      ).run();
      tableMoved = true;

      await testEnv.IDENTITY_DB.batch(
        migration("0007_guest_lifecycle.sql").queries.map((query) =>
          testEnv.IDENTITY_DB.prepare(query),
        ),
      );
      await testEnv.IDENTITY_DB.batch([
        testEnv.IDENTITY_DB.prepare(
          `INSERT INTO platform_guest_grant
             (id, guest_id, service_id, audience, resource_id, assertion_kind,
              capabilities, created_at, revoked_at, revoked_reason)
             VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, NULL, NULL)`,
        ).bind(
          grantId,
          guest.guestId,
          registration.serviceId,
          registration.audience,
          resourceId,
          JSON.stringify(["resource:read"]),
          Date.now(),
        ),
        testEnv.IDENTITY_DB.prepare(
          `INSERT INTO platform_credential
             (id, credential_hash, kind, subject_id, organization_id,
              membership_id, grant_id, audience, capabilities, resource_ids,
              expires_at, revoked_at, name, created_at, revoked_reason,
              replaced_by_id, predecessor_id)
             VALUES (?, ?, 'guest', ?, NULL, NULL, ?, ?, ?, json_array(?),
                     NULL, NULL, 'Guest resource grant', ?, NULL, NULL, NULL)`,
        ).bind(
          credentialId,
          await hashOpaque(credential),
          guest.guestId,
          grantId,
          registration.audience,
          JSON.stringify(["resource:read"]),
          resourceId,
          Date.now(),
        ),
      ]);
      expect(await hasGuestGrantPermissionColumn(testEnv.IDENTITY_DB)).toBe(
        false,
      );
      expect(
        await testEnv.IDENTITY_DB.prepare(
          "SELECT id FROM platform_guest_grant WHERE id = ?",
        )
          .bind(grantId)
          .first<{ id: string }>(),
      ).toEqual({ id: grantId });

      await applyD1Migrations(
        testEnv.IDENTITY_DB,
        [migration("0009_guest_permission_grants.sql")],
        migrationTable,
      );
      expect(
        await testEnv.IDENTITY_DB.prepare(
          "SELECT permission_id FROM platform_guest_grant WHERE id = ?",
        )
          .bind(grantId)
          .first<{ permission_id: string }>(),
      ).toEqual({ permission_id: DEFAULT_GUEST_PERMISSION_ID });

      const platform = platformClient(registration);
      expect((await platform.authenticate(credential)).status).toBe(
        "authenticated",
      );
      const renewed = successfulGrant(
        await client.renewGuestGrant({
          grantId,
          bootstrapCredential: guest.bootstrapCredential,
          resourceId,
          capabilities: ["resource:read"],
          assertion: { kind: "owner", storedOwnerId: guest.guestId },
        }),
      );
      renewedCredentialId = renewed.credentialId;
      expect(renewed.grantId).toBe(grantId);
      expect((await platform.authenticate(credential)).status).toBe(
        "invalid_credential",
      );
      expect((await platform.authenticate(renewed.credential)).status).toBe(
        "authenticated",
      );
    } finally {
      if (tableMoved) {
        await restoreGuestGrantTable(
          testEnv.IDENTITY_DB,
          backupTable,
          migrationTable,
          originalRows,
          grantId,
          [credentialId, renewedCredentialId],
        );
      }
    }
  });

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
        { assertion: { kind: "participant", permissionId: "public" } },
      ),
    );
    const managementGrant = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "management",
        {
          assertion: { kind: "participant", permissionId: "management" },
        },
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

  it("rejects capability widening when the service permits the wider capability", async () => {
    const registration = service(["resource:read", "resource:write"]);
    await registerTestService(testEnv.IDENTITY_DB, registration);
    const client = guestClient(registration);
    const guest = await client.createGuest();
    expect(guest.status).toBe("success");
    if (guest.status !== "success") return;

    const resourceId = `resource-no-widening-${crypto.randomUUID()}`;
    const created = successfulGrant(
      await grant(
        client,
        guest.guestId,
        guest.bootstrapCredential,
        resourceId,
        "read-only",
        { capabilities: ["resource:read"] },
      ),
    );
    expect(
      await client.renewGuestGrant({
        grantId: created.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId,
        capabilities: ["resource:write"],
        assertion: ownerAssertion(guest.guestId, "read-only"),
      }),
    ).toEqual({ status: "grant_denied" });
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
