import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServicePrincipal,
  issueServicePrincipalCredential,
  rotateServicePrincipalCredential,
} from "../../src/agent-state";
import { hashOpaque, opaqueSecret } from "../../src/platform-state";
import { updateServiceMetadata } from "../../src/service-registration";
import { handleResourceRequest } from "./fixtures/resource-service";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;
const mutableEnv = testEnv as unknown as Record<string, string>;
let providerIdentity = {
  subject: "t11-service-provider",
  name: "T11 Provider",
  email: "t11-service-provider@example.test",
};

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const values = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const value of values) {
      const pair = value.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join("; ");
}

async function loginAs(input: {
  subject: string;
  name: string;
  email: string;
}): Promise<{
  id: string;
  email: string;
  cookie: string;
  organizationId: string;
}> {
  providerIdentity = input;
  const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "http://localhost/account",
    }),
  });
  const state = new URL(
    ((await start.json()) as { url: string }).url,
  ).searchParams.get("state");
  if (!state) throw new Error("Google state missing");
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/google?code=${encodeURIComponent(input.subject)}&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: cookiesFrom(start),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
  const cookie = cookiesFrom(start, callback);
  const user = await testEnv.IDENTITY_DB.prepare(
    'SELECT id, email FROM "user" WHERE email = ?',
  )
    .bind(input.email)
    .first<{ id: string; email: string }>();
  if (!user) throw new Error("user missing after login");
  const me = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie },
  });
  const organization = (await me.json()) as { organizationId: string };
  return { ...user, cookie, organizationId: organization.organizationId };
}

async function post(
  path: string,
  cookie: string,
  body: unknown,
  origin = testEnv.PLATFORM_BASE_URL,
) {
  return SELF.fetch(`http://localhost${path}`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function client(service: TestService) {
  return createPlatformClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch: (input, init) => SELF.fetch(input, init),
  });
}

async function inviteAndAccept(
  owner: Awaited<ReturnType<typeof loginAs>>,
  member: Awaited<ReturnType<typeof loginAs>>,
  role: "owner" | "admin" | "member",
): Promise<void> {
  const invitation = await post(
    "/api/account/invitations/create",
    owner.cookie,
    {
      organizationId: owner.organizationId,
      email: member.email,
      role,
    },
  );
  expect(invitation.status, await invitation.clone().text()).toBe(201);
  const invitationId = ((await invitation.json()) as { id: string }).id;
  const accepted = await post(
    "/api/account/invitations/accept",
    member.cookie,
    {
      invitationId,
    },
  );
  expect(accepted.status, await accepted.clone().text()).toBe(200);
}

async function serviceCredential(
  service: TestService,
  credential: string,
): Promise<Response> {
  return SELF.fetch("http://localhost/internal/v1/authenticate", {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.verifier}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ credential }),
  });
}

describe("T11 organization-owned service principals", () => {
  beforeEach(() => {
    mutableEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "90";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (
          url.hostname === "oauth2.googleapis.com" &&
          url.pathname === "/token"
        ) {
          const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          const claims = btoa(
            JSON.stringify({
              iss: "https://accounts.google.com",
              aud: "platform-t02-google-client",
              sub: providerIdentity.subject,
              email: providerIdentity.email,
              email_verified: true,
              name: providerIdentity.name,
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          )
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
          return Response.json({
            access_token: "platform-t11-provider-token",
            expires_in: 3600,
            id_token: `${header}.${claims}.synthetic-signature`,
            token_type: "Bearer",
          });
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("issues stable service credentials through both audiences and survives creator departure", async () => {
    const owner = await loginAs({
      subject: "t11-service-owner",
      name: "T11 Service Owner",
      email: "t11-service-owner@example.test",
    });
    const first: TestService = {
      serviceId: "t11-service-one",
      audience: "https://t11-service-one.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read", "resource:write"],
    };
    const second: TestService = {
      serviceId: "t11-service-two",
      audience: "https://t11-service-two.0000.test/mcp",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, first);
    await registerTestService(testEnv.IDENTITY_DB, second);

    const created = await post(
      "/api/account/service-principals",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        name: "Automation service",
        kind: "agent",
      },
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const principal = (await created.json()) as {
      subjectId: string;
      kind: string;
    };
    expect(principal.kind).toBe("service");
    expect(principal.subjectId).toBeTruthy();

    const grantOneResponse = await post(
      "/api/account/service-principals/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        serviceId: first.serviceId,
        capabilities: ["resource:read", "resource:write"],
      },
    );
    const grantTwoResponse = await post(
      "/api/account/service-principals/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(grantOneResponse.status, await grantOneResponse.clone().text()).toBe(
      201,
    );
    expect(grantTwoResponse.status, await grantTwoResponse.clone().text()).toBe(
      201,
    );
    const grantOne = (await grantOneResponse.json()) as { id: string };
    const grantTwo = (await grantTwoResponse.json()) as { id: string };

    const issueOne = await post(
      "/api/account/service-principals/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        grantId: grantOne.id,
        serviceId: first.serviceId,
        capabilities: ["resource:read", "resource:write"],
      },
    );
    const issueTwo = await post(
      "/api/account/service-principals/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        grantId: grantTwo.id,
        serviceId: second.serviceId,
        capabilities: ["resource:read"],
      },
    );
    expect(issueOne.status, await issueOne.clone().text()).toBe(201);
    expect(issueTwo.status, await issueTwo.clone().text()).toBe(201);
    const credentialOne = (await issueOne.json()) as {
      credential: string;
      credentialId: string;
    };
    const credentialTwo = (await issueTwo.json()) as {
      credential: string;
      credentialId: string;
    };
    const firstAuth = await client(first).authenticate(
      credentialOne.credential,
    );
    const secondAuth = await client(second).authenticate(
      credentialTwo.credential,
    );
    expect(firstAuth.status).toBe("authenticated");
    expect(secondAuth.status).toBe("authenticated");
    if (
      firstAuth.status === "authenticated" &&
      secondAuth.status === "authenticated"
    ) {
      expect(firstAuth.principal.kind).toBe("service");
      expect(secondAuth.principal.kind).toBe("service");
      expect(firstAuth.principal.subjectId).toBe(
        secondAuth.principal.subjectId,
      );
      if (
        firstAuth.principal.kind === "service" &&
        secondAuth.principal.kind === "service"
      ) {
        expect(firstAuth.principal.grantId).not.toBe(
          secondAuth.principal.grantId,
        );
      }
    }
    expect(
      (await client(second).authenticate(credentialOne.credential)).status,
    ).toBe("invalid_credential");

    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience) VALUES (?, 'organization', ?, ?, ?), (?, 'organization', ?, ?, ?)",
    )
      .bind(
        "t11-service-resource-one",
        owner.organizationId,
        Date.now(),
        first.audience,
        "t11-service-resource-two",
        owner.organizationId,
        Date.now(),
        second.audience,
      )
      .run();
    const read = await handleResourceRequest(
      new Request("https://fixture.test/resources/t11-service-resource-one", {
        headers: { authorization: `Bearer ${credentialOne.credential}` },
      }),
      {
        database: testEnv.IDENTITY_DB,
        platformBaseUrl: testEnv.PLATFORM_BASE_URL,
        authority: testEnv.PLATFORM_AUTHORITY_ID,
        audience: first.audience,
        serviceId: first.serviceId,
        serviceVerifier: first.verifier,
        guestGrantIssuer: first.guestGrantIssuer,
        fetch: (input, init) => SELF.fetch(input, init),
      },
    );
    expect(read.status).toBe(200);

    const agentRoute = await post("/api/account/agents/update", owner.cookie, {
      organizationId: owner.organizationId,
      agentId: principal.subjectId,
      name: "must remain service",
    });
    expect(agentRoute.status).toBe(404);
    const serviceRoute = await post(
      "/api/account/service-principals/update",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        name: "renamed service",
        kind: "agent",
      },
    );
    expect(serviceRoute.status).toBe(200);

    const member = await loginAs({
      subject: "t11-service-member",
      name: "T11 Service Member",
      email: "t11-service-member@example.test",
    });
    await inviteAndAccept(owner, member, "member");
    expect(
      (
        await post("/api/account/service-principals/lifecycle", member.cookie, {
          organizationId: owner.organizationId,
          subjectId: principal.subjectId,
          action: "disable",
        })
      ).status,
    ).toBe(403);

    const admin = await loginAs({
      subject: "t11-service-admin",
      name: "T11 Service Admin",
      email: "t11-service-admin@example.test",
    });
    await inviteAndAccept(owner, admin, "admin");
    const adminMembership = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM member WHERE organizationId = ? AND userId = ?",
    )
      .bind(owner.organizationId, admin.id)
      .first<{ id: string }>();
    if (!adminMembership) throw new Error("admin membership missing");
    expect(
      (
        await post("/api/account/members/role", owner.cookie, {
          organizationId: owner.organizationId,
          membershipId: adminMembership.id,
          role: "owner",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/api/account/members/leave", owner.cookie, {
          organizationId: owner.organizationId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await SELF.fetch(
          `http://localhost/api/account/service-principals?organizationId=${encodeURIComponent(owner.organizationId)}`,
          { headers: { cookie: admin.cookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      (await client(first).authenticate(credentialOne.credential)).status,
    ).toBe("authenticated");
  });

  it("enforces current kind, lifecycle, grant, catalog, expiry and credential boundaries", async () => {
    const owner = await loginAs({
      subject: "t11-service-boundary-owner",
      name: "T11 Boundary Owner",
      email: "t11-service-boundary-owner@example.test",
    });
    const service: TestService = {
      serviceId: "t11-service-boundary",
      audience: "https://t11-service-boundary.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read", "resource:write"],
    };
    const foreign: TestService = {
      serviceId: "t11-service-foreign",
      audience: "https://t11-service-foreign.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    await registerTestService(testEnv.IDENTITY_DB, foreign);
    const created = await post(
      "/api/account/service-principals",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        name: "Boundary service",
      },
    );
    const principal = (await created.json()) as { subjectId: string };
    const grantResponse = await post(
      "/api/account/service-principals/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        serviceId: service.serviceId,
        capabilities: ["resource:read", "resource:write"],
      },
    );
    const grant = (await grantResponse.json()) as { id: string };
    const issue = await post(
      "/api/account/service-principals/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        grantId: grant.id,
        serviceId: service.serviceId,
        capabilities: ["resource:read", "resource:write"],
        lifetimeDays: 1,
      },
    );
    expect(issue.status, await issue.clone().text()).toBe(201);
    const issued = (await issue.json()) as {
      credential: string;
      credentialId: string;
    };
    expect((await client(service).authenticate(issued.credential)).status).toBe(
      "authenticated",
    );
    expect((await client(foreign).authenticate(issued.credential)).status).toBe(
      "invalid_credential",
    );
    expect((await serviceCredential(service, issued.credential)).status).toBe(
      200,
    );
    expect(
      (
        await SELF.fetch("http://localhost/internal/v1/authenticate", {
          method: "POST",
          headers: {
            authorization: `Bearer ${service.guestGrantIssuer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ credential: issued.credential }),
        })
      ).status,
    ).toBe(503);

    const disabled = await post(
      "/api/account/service-principals/lifecycle",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        action: "disable",
      },
    );
    expect(disabled.status).toBe(200);
    expect((await client(service).authenticate(issued.credential)).status).toBe(
      "invalid_credential",
    );
    await post("/api/account/service-principals/lifecycle", owner.cookie, {
      organizationId: owner.organizationId,
      subjectId: principal.subjectId,
      action: "restore",
    });
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_credential SET expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 1, issued.credentialId)
      .run();
    expect((await client(service).authenticate(issued.credential)).status).toBe(
      "invalid_credential",
    );

    const renewed = await post(
      "/api/account/service-principals/credentials",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: principal.subjectId,
        grantId: grant.id,
        serviceId: service.serviceId,
        capabilities: ["resource:read"],
      },
    );
    const renewedBody = (await renewed.json()) as {
      credential: string;
      credentialId: string;
    };
    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: service.serviceId,
      capabilities: ["resource:write"],
      displayName: "Boundary narrowed",
    });
    expect(
      (await client(service).authenticate(renewedBody.credential)).status,
    ).toBe("invalid_credential");
    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: service.serviceId,
      capabilities: ["resource:read", "resource:write"],
      displayName: "Boundary restored",
    });

    const currentKind = await testEnv.IDENTITY_DB.prepare(
      "SELECT kind FROM platform_agent WHERE id = ?",
    )
      .bind(principal.subjectId)
      .first<{ kind: string }>();
    expect(currentKind?.kind).toBe("service");
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_agent SET kind = 'agent' WHERE id = ?",
      )
        .bind(principal.subjectId)
        .run(),
    ).rejects.toThrow("machine kind is immutable");

    const raw = opaqueSecret("0000_service_");
    await expect(
      testEnv.IDENTITY_DB.prepare(
        `INSERT INTO platform_credential
         (id, credential_hash, kind, subject_id, organization_id, membership_id,
          grant_id, audience, capabilities, resource_ids, expires_at, revoked_at,
          name, created_at, revoked_reason, replaced_by_id, predecessor_id)
         VALUES (?, ?, 'agent', ?, ?, NULL, ?, ?, ?, '[]', ?, NULL, ?, ?, NULL, NULL, NULL)`,
      )
        .bind(
          crypto.randomUUID(),
          await hashOpaque(raw),
          principal.subjectId,
          owner.organizationId,
          grant.id,
          service.audience,
          JSON.stringify(["resource:read"]),
          Date.now() + 86_400_000,
          "forged",
          Date.now(),
        )
        .run(),
    ).rejects.toThrow("machine credential kind mismatch");
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_credential SET kind = 'human' WHERE id = ?",
      )
        .bind(issued.credentialId)
        .run(),
    ).rejects.toThrow("machine credential kind mismatch");

    const serviceRotation = await createServicePrincipal(testEnv.IDENTITY_DB, {
      actorUserId: owner.id,
      organizationId: owner.organizationId,
      name: "Rotation service",
    });
    if (!serviceRotation) throw new Error("rotation principal missing");
    const rotationGrant = await post(
      "/api/account/service-principals/grants",
      owner.cookie,
      {
        organizationId: owner.organizationId,
        subjectId: serviceRotation.subjectId,
        serviceId: service.serviceId,
        capabilities: ["resource:read"],
      },
    );
    const rotationGrantBody = (await rotationGrant.json()) as { id: string };
    const registeredService = {
      ...service,
      verifierHash: await hashOpaque(service.verifier),
    };
    const rotationCredential = await issueServicePrincipalCredential(
      testEnv.IDENTITY_DB,
      {
        actorUserId: owner.id,
        service: registeredService,
        organizationId: owner.organizationId,
        subjectId: serviceRotation.subjectId,
        grantId: rotationGrantBody.id,
        capabilities: ["resource:read"],
        expiresAt: Date.now() + 86_400_000,
      },
    );
    const rotate = () =>
      rotateServicePrincipalCredential(testEnv.IDENTITY_DB, {
        actorUserId: owner.id,
        service: registeredService,
        organizationId: owner.organizationId,
        subjectId: serviceRotation.subjectId,
        grantId: rotationGrantBody.id,
        credentialId: rotationCredential.credentialId,
        expiresAt: Date.now() + 86_400_000,
      });
    const rotations = await Promise.allSettled([rotate(), rotate()]);
    expect(
      rotations.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      rotations.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });
});
