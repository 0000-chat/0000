import { env as runtimeEnv } from "cloudflare:workers";
import type {
  AgentPrincipal,
  HumanPrincipal,
  ServicePrincipal,
} from "@0000/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseBindablePlatformPrincipal,
  resolvePlatformBinding,
  type BindablePlatformPrincipal,
} from "../control-directory/platform-bindings";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const timestamp = "2026-08-29T00:00:00.000Z";
const future = "2030-01-01T00:00:00.000Z";
const authority = "platform-deployment";
const organizationId = "platform-org-pilot";

type PlatformKind = "human" | "agent" | "service";

type BindingInput = {
  bindingId: string;
  platformAuthority?: string;
  platformOrganizationId?: string;
  platformKind?: PlatformKind;
  platformSubjectId?: string;
  platformMembershipId?: string | null;
  platformGrantId?: string | null;
  localTenantId?: string;
  localPrincipalId?: string;
  localMembershipId?: string;
  localIdentityId?: string | null;
  localInstallationId?: string | null;
  localClientId?: string | null;
  status?: "pending" | "active" | "revoked";
  revokedAt?: string | null;
};

async function insertBinding(input: BindingInput): Promise<void> {
  const platformKind = input.platformKind ?? "human";
  const status = input.status ?? "active";
  await env.CONTROL_DB.prepare(
    `INSERT INTO platform_bindings (
        binding_id,
        platform_authority,
        platform_kind,
        platform_subject_id,
        platform_organization_id,
        platform_membership_id,
        platform_grant_id,
        local_tenant_id,
        local_principal_id,
        local_membership_id,
        local_identity_id,
        local_installation_id,
        local_client_id,
        status,
        created_at,
        updated_at,
        revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.bindingId,
      input.platformAuthority ?? authority,
      platformKind,
      input.platformSubjectId ?? input.bindingId,
      input.platformOrganizationId ?? organizationId,
      input.platformMembershipId ??
        (platformKind === "human"
          ? `platform-membership-${input.bindingId}`
          : null),
      input.platformGrantId ??
        (platformKind === "human" ? null : `platform-grant-${input.bindingId}`),
      input.localTenantId ?? "tenant_pilot",
      input.localPrincipalId ?? "principal_human",
      input.localMembershipId ?? "membership_human",
      input.localIdentityId ?? null,
      input.localInstallationId ?? null,
      input.localClientId ?? null,
      status,
      timestamp,
      timestamp,
      input.revokedAt ?? (status === "revoked" ? timestamp : null),
    )
    .run();
}

async function insertServiceDirectoryRows(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'service', ?, 'active', ?, ?)",
    ).bind(
      "principal_service",
      "https://legacy.example/",
      "legacy-service",
      "Service",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
    ).bind(
      "membership_service",
      "tenant_pilot",
      "principal_service",
      timestamp,
      timestamp,
    ),
  ]);
}

async function insertOtherTenant(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind("tenant_other", "other", "Other", timestamp, timestamp),
    env.CONTROL_DB.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      "principal_other",
      "https://legacy.example/",
      "other-subject",
      "Other",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
    ).bind(
      "membership_other",
      "tenant_other",
      "principal_other",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'active', ?, ?)",
    ).bind(
      "identity_other",
      "tenant_other",
      "Other identity",
      timestamp,
      timestamp,
    ),
  ]);
}

async function insertInstallation(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uri, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).bind(
      "client-binding",
      "Binding client",
      "https://client.example/callback",
      timestamp,
      timestamp,
    ),
    env.CONTROL_DB.prepare(
      `INSERT INTO oauth_client_installations (
          id, client_id, redirect_uri, resource, human_issuer, human_subject,
          tenant_id, membership_id, principal_id, identity_id, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      "installation-binding",
      "client-binding",
      "https://client.example/callback",
      "https://communicator.example/mcp",
      "https://legacy.example/",
      "human-subject",
      "tenant_pilot",
      "membership_human",
      "principal_human",
      "identity_human",
      timestamp,
      timestamp,
    ),
  ]);
}

const humanPrincipal: HumanPrincipal = {
  version: 1,
  kind: "human",
  authority,
  subjectId: "platform-human",
  credentialId: "credential-one",
  audience: "https://communicator.example",
  capabilities: ["conversation.read"],
  expiresAt: future,
  organizationId,
  membershipId: "platform-membership-human",
};

const operatorPrincipal: HumanPrincipal = {
  ...humanPrincipal,
  subjectId: "platform-operator",
  membershipId: "platform-membership-operator",
};

const agentPrincipal: AgentPrincipal = {
  version: 1,
  kind: "agent",
  authority,
  subjectId: "platform-agent",
  credentialId: "agent-credential-one",
  audience: "https://communicator.example",
  capabilities: ["conversation.read"],
  expiresAt: future,
  organizationId,
  grantId: "platform-grant-agent",
};

const servicePrincipal: ServicePrincipal = {
  ...agentPrincipal,
  kind: "service",
  subjectId: "platform-service",
  credentialId: "service-credential-one",
  grantId: "platform-grant-service",
};

async function resolve(
  principal: BindablePlatformPrincipal,
  tenantHint?: string,
) {
  return resolvePlatformBinding(env.CONTROL_DB, principal, tenantHint);
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
});

describe("parseBindablePlatformPrincipal", () => {
  it("reuses the shared parser and rejects guest or incoherent kind fields", () => {
    expect(
      parseBindablePlatformPrincipal(humanPrincipal, {
        authority,
        audience: humanPrincipal.audience,
        now: Date.UTC(2026, 0, 1),
      }),
    ).toEqual(humanPrincipal);
    expect(
      parseBindablePlatformPrincipal(
        {
          ...humanPrincipal,
          grantId: "wrong-kind-grant",
        },
        {
          authority,
          audience: humanPrincipal.audience,
          now: Date.UTC(2026, 0, 1),
        },
      ),
    ).toBeNull();
    expect(
      parseBindablePlatformPrincipal(
        {
          ...agentPrincipal,
          membershipId: "wrong-kind-membership",
        },
        {
          authority,
          audience: agentPrincipal.audience,
          now: Date.UTC(2026, 0, 1),
        },
      ),
    ).toBeNull();
    expect(
      parseBindablePlatformPrincipal(
        {
          version: 1,
          kind: "guest",
          authority,
          subjectId: "guest",
          credentialId: "guest-credential",
          audience: humanPrincipal.audience,
          capabilities: [],
          expiresAt: null,
          grantId: "guest-grant",
          resourceIds: [],
        },
        { authority, audience: humanPrincipal.audience },
      ),
    ).toBeNull();
  });
});

describe("resolvePlatformBinding", () => {
  it("resolves human, operator, agent, and service targets with current local role and kind", async () => {
    await insertServiceDirectoryRows();
    await insertBinding({
      bindingId: "binding-human",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: humanPrincipal.membershipId,
      localIdentityId: "identity_human",
    });
    await insertBinding({
      bindingId: "binding-operator",
      platformSubjectId: operatorPrincipal.subjectId,
      platformMembershipId: operatorPrincipal.membershipId,
      localPrincipalId: "principal_operator",
      localMembershipId: "membership_operator",
      localIdentityId: "identity_human",
    });
    await insertBinding({
      bindingId: "binding-agent",
      platformKind: "agent",
      platformSubjectId: agentPrincipal.subjectId,
      platformMembershipId: null,
      platformGrantId: agentPrincipal.grantId,
      localPrincipalId: "principal_agent",
      localMembershipId: "membership_agent",
      localIdentityId: "identity_agent",
    });
    await insertBinding({
      bindingId: "binding-service",
      platformKind: "service",
      platformSubjectId: servicePrincipal.subjectId,
      platformMembershipId: null,
      platformGrantId: servicePrincipal.grantId,
      localPrincipalId: "principal_service",
      localMembershipId: "membership_service",
    });

    await expect(resolve(humanPrincipal)).resolves.toMatchObject({
      ok: true,
      binding: {
        bindingId: "binding-human",
        kind: "human",
        localTenantId: "tenant_pilot",
        localPrincipalId: "principal_human",
        localPrincipalKind: "human",
        localMembershipId: "membership_human",
        localRole: "owner",
        localIdentityId: "identity_human",
      },
    });
    await expect(resolve(operatorPrincipal)).resolves.toMatchObject({
      ok: true,
      binding: {
        localPrincipalId: "principal_operator",
        localPrincipalKind: "operator",
        localRole: "admin",
      },
    });
    await expect(resolve(agentPrincipal)).resolves.toMatchObject({
      ok: true,
      binding: {
        bindingId: "binding-agent",
        kind: "agent",
        platformGrantId: agentPrincipal.grantId,
        localPrincipalKind: "agent",
        localRole: "member",
      },
    });
    await expect(resolve(servicePrincipal)).resolves.toMatchObject({
      ok: true,
      binding: {
        bindingId: "binding-service",
        kind: "service",
        platformGrantId: servicePrincipal.grantId,
        localPrincipalKind: "service",
        localIdentityId: null,
      },
    });
  });

  it("keeps credential rotation on the same exact binding tuple", async () => {
    await insertBinding({
      bindingId: "binding-rotation",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: humanPrincipal.membershipId,
      localIdentityId: "identity_human",
    });

    const rotated = { ...humanPrincipal, credentialId: "credential-two" };
    await expect(resolve(rotated)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        binding: expect.objectContaining({ bindingId: "binding-rotation" }),
      }),
    );
  });

  it.each([
    ["wrong authority", { authority: "other-deployment" }],
    ["wrong organization", { organizationId: "other-org" }],
    ["wrong subject", { subjectId: "other-subject" }],
    ["old membership", { membershipId: "platform-membership-old" }],
  ])("does not resolve a %s tuple", async (_label, changes) => {
    await insertBinding({
      bindingId: "binding-human",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: humanPrincipal.membershipId,
      localIdentityId: "identity_human",
    });
    const result = await resolve({ ...humanPrincipal, ...changes });
    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("requires an exact tenant hint and rejects a machine kind or grant mismatch", async () => {
    await insertServiceDirectoryRows();
    await insertBinding({
      bindingId: "binding-agent",
      platformKind: "agent",
      platformSubjectId: agentPrincipal.subjectId,
      platformMembershipId: null,
      platformGrantId: agentPrincipal.grantId,
      localPrincipalId: "principal_agent",
      localMembershipId: "membership_agent",
      localIdentityId: "identity_agent",
    });

    expect(await resolve(agentPrincipal, "tenant_other")).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await resolve({ ...agentPrincipal, kind: "service" })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(
      await resolve({ ...agentPrincipal, grantId: "platform-grant-old" }),
    ).toEqual({ ok: false, code: "not_found" });
  });

  it.each([
    ["pending", "binding-pending"],
    ["revoked", "binding-revoked"],
  ] as const)(
    "does not treat a %s binding as authority",
    async (status, bindingId) => {
      await insertBinding({
        bindingId,
        platformSubjectId: `${bindingId}-subject`,
        platformMembershipId: `${bindingId}-membership`,
        status,
      });
      expect(
        await resolve({
          ...humanPrincipal,
          subjectId: `${bindingId}-subject`,
          membershipId: `${bindingId}-membership`,
        }),
      ).toEqual({ ok: false, code: "not_found" });
    },
  );

  it.each([
    ["tenant", "tenants", "tenant_pilot", "disabled"],
    ["tenant", "tenants", "tenant_pilot", "revoked"],
    ["principal", "principals", "principal_human", "disabled"],
    ["principal", "principals", "principal_human", "revoked"],
    ["membership", "memberships", "membership_human", "disabled"],
    ["membership", "memberships", "membership_human", "revoked"],
  ] as const)(
    "rejects a binding when its local %s is %s",
    async (_label, table, id, status) => {
      await insertBinding({
        bindingId: "binding-human",
        platformSubjectId: humanPrincipal.subjectId,
        platformMembershipId: humanPrincipal.membershipId,
        localIdentityId: "identity_human",
      });
      await env.CONTROL_DB.prepare(
        `UPDATE ${table} SET status = ? WHERE id = ?`,
      )
        .bind(status, id)
        .run();
      expect(await resolve(humanPrincipal)).toEqual({
        ok: false,
        code: "not_found",
      });
    },
  );

  it("requires current identity grants and preserves installation provenance", async () => {
    await insertInstallation();
    await insertBinding({
      bindingId: "binding-installation",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: humanPrincipal.membershipId,
      localIdentityId: "identity_human",
      localInstallationId: "installation-binding",
      localClientId: "client-binding",
    });
    await expect(resolve(humanPrincipal)).resolves.toMatchObject({
      ok: true,
      binding: {
        bindingId: "binding-installation",
        localIdentityId: "identity_human",
        localInstallationId: "installation-binding",
        localClientId: "client-binding",
      },
    });

    await env.CONTROL_DB.prepare(
      "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ?",
    )
      .bind("tenant_pilot", "membership_human", "identity_human")
      .run();
    expect(await resolve(humanPrincipal)).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it.each([
    [
      "installation",
      "UPDATE oauth_client_installations SET status = 'revoked', revoked_at = ? WHERE id = ?",
    ],
    [
      "client",
      "UPDATE oauth_clients SET status = 'revoked' WHERE client_id = ?",
    ],
    ["identity", "UPDATE identities SET status = 'disabled' WHERE id = ?"],
  ] as const)(
    "rejects a binding when its %s is no longer active",
    async (_label, sql) => {
      await insertInstallation();
      await insertBinding({
        bindingId: "binding-installation",
        platformSubjectId: humanPrincipal.subjectId,
        platformMembershipId: humanPrincipal.membershipId,
        localIdentityId: "identity_human",
        localInstallationId: "installation-binding",
        localClientId: "client-binding",
      });
      if (sql.includes("oauth_client_installations")) {
        await env.CONTROL_DB.prepare(sql)
          .bind(timestamp, "installation-binding")
          .run();
      } else {
        await env.CONTROL_DB.prepare(sql)
          .bind(
            sql.includes("oauth_clients") ? "client-binding" : "identity_human",
          )
          .run();
      }
      expect(await resolve(humanPrincipal)).toEqual({
        ok: false,
        code: "not_found",
      });
    },
  );
});

describe("platform_bindings database boundary", () => {
  it("rejects incoherent discriminants, cross-tenant targets, and association changes", async () => {
    await insertOtherTenant();
    await insertBinding({
      bindingId: "binding-anchor",
      platformSubjectId: "anchor-subject",
      platformMembershipId: "anchor-membership",
      localIdentityId: "identity_human",
    });
    await expect(
      insertBinding({
        bindingId: "binding-cross-tenant-membership",
        platformSubjectId: "cross-tenant-membership",
        localMembershipId: "membership_other",
      }),
    ).rejects.toThrow();
    await expect(
      insertBinding({
        bindingId: "binding-cross-tenant-identity",
        platformSubjectId: "cross-tenant-identity",
        localIdentityId: "identity_other",
      }),
    ).rejects.toThrow();
    await expect(
      insertBinding({
        bindingId: "binding-wrong-kind",
        platformKind: "agent",
        platformSubjectId: "wrong-kind",
        platformMembershipId: null,
        platformGrantId: "grant-wrong-kind",
        localPrincipalId: "principal_human",
        localMembershipId: "membership_human",
        localIdentityId: "identity_human",
      }),
    ).rejects.toThrow();
    await expect(
      insertBinding({
        bindingId: "binding-other-tenant",
        platformSubjectId: "other-tenant",
        localTenantId: "tenant_other",
        localPrincipalId: "principal_other",
        localMembershipId: "membership_other",
      }),
    ).rejects.toThrow();
    await expect(
      insertBinding({
        bindingId: "binding-other-org",
        platformSubjectId: "other-org",
        platformOrganizationId: "other-platform-org",
        platformMembershipId: "platform-membership-other-org",
        localIdentityId: "identity_human",
      }),
    ).rejects.toThrow();
    await insertInstallation();
    await expect(
      insertBinding({
        bindingId: "binding-mismatched-installation",
        platformSubjectId: "mismatched-installation",
        localIdentityId: "identity_human",
        localInstallationId: "installation-binding",
        localClientId: "missing-client",
      }),
    ).rejects.toThrow();
  });

  it("rejects a local tenant reassignment after its first Platform organization", async () => {
    await insertBinding({
      bindingId: "binding-first",
      platformSubjectId: "first-subject",
      platformMembershipId: "first-membership",
      localIdentityId: "identity_human",
    });
    await expect(
      insertBinding({
        bindingId: "binding-other-org",
        platformSubjectId: "other-subject",
        platformOrganizationId: "other-platform-org",
        platformMembershipId: "other-membership",
        localIdentityId: "identity_human",
      }),
    ).rejects.toThrow();
  });

  it("keeps tuple and targets immutable, prevents revival, deletion, and tuple reuse", async () => {
    await insertBinding({
      bindingId: "binding-terminal",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: humanPrincipal.membershipId,
      localIdentityId: "identity_human",
    });
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE platform_bindings SET local_tenant_id = ? WHERE binding_id = ?",
      )
        .bind("tenant_other", "binding-terminal")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE platform_bindings SET platform_subject_id = ? WHERE binding_id = ?",
      )
        .bind("changed-subject", "binding-terminal")
        .run(),
    ).rejects.toThrow();
    await env.CONTROL_DB.prepare(
      "UPDATE platform_bindings SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE binding_id = ?",
    )
      .bind(timestamp, timestamp, "binding-terminal")
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE platform_bindings SET status = 'active' WHERE binding_id = ?",
      )
        .bind("binding-terminal")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM platform_bindings WHERE binding_id = ?",
      )
        .bind("binding-terminal")
        .run(),
    ).rejects.toThrow();
    await expect(
      insertBinding({
        bindingId: "binding-reuse",
        platformSubjectId: humanPrincipal.subjectId,
        platformMembershipId: humanPrincipal.membershipId,
        localIdentityId: "identity_human",
      }),
    ).rejects.toThrow();
  });

  it("allows a replacement Platform membership as a distinct explicit binding", async () => {
    await insertBinding({
      bindingId: "binding-old",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: "platform-membership-old",
      localIdentityId: "identity_human",
      status: "revoked",
    });
    await insertBinding({
      bindingId: "binding-new",
      platformSubjectId: humanPrincipal.subjectId,
      platformMembershipId: "platform-membership-new",
      localIdentityId: "identity_human",
    });
    await expect(
      resolve({
        ...humanPrincipal,
        membershipId: "platform-membership-new",
      }),
    ).resolves.toMatchObject({
      ok: true,
      binding: { bindingId: "binding-new" },
    });
  });

  it("fails closed with one fixed unavailable result on a directory outage", async () => {
    const unavailableDb = {
      withSession() {
        throw new Error("database offline");
      },
    } as unknown as D1Database;
    expect(await resolvePlatformBinding(unavailableDb, humanPrincipal)).toEqual(
      {
        ok: false,
        code: "directory_unavailable",
      },
    );
  });
});
