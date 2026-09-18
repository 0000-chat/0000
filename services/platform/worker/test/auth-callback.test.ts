import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueSecret } from "../../src/platform-state";
import {
  attestGuestResource,
  handleResourceRequest,
} from "./fixtures/resource-service";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;

function cookiesFrom(response: Response): string {
  const all = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  return all
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function bearer(credential: string): HeadersInit {
  return { authorization: `Bearer ${credential}` };
}

function requestFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return SELF.fetch(input, init);
}

async function fixtureRead(
  service: TestService,
  database: D1Database,
  resourceId: string,
  credential: string,
  overrides: Partial<{ authority: string; fetch: typeof fetch }> = {},
): Promise<Response> {
  return handleResourceRequest(
    new Request(`http://fixture.test/resources/${resourceId}`, {
      headers: bearer(credential),
    }),
    {
      database,
      platformBaseUrl: testEnv.PLATFORM_BASE_URL,
      authority: overrides.authority ?? testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      guestGrantIssuer: service.guestGrantIssuer,
      fetch: overrides.fetch ?? requestFetch,
    },
  );
}

async function issueCredential(
  cookies: string,
  serviceId: string,
): Promise<{ credential: string; credentialId: string; expiresAt: number }> {
  const response = await SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: {
      cookie: cookies,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({ serviceId, capabilities: ["resource:read"] }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    credential: string;
    credentialId: string;
    expiresAt: number;
  }>;
}

describe("Platform shared-auth T01 runtime trace", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (
          url.hostname === "github.com" &&
          url.pathname === "/login/oauth/access_token"
        ) {
          return Response.json({
            access_token: "provider-test-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: 812345,
            login: "platform-probe",
            name: "Platform Probe",
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            { email: "probe@example.test", primary: true, verified: true },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("signs in, enforces current principal state, issues scoped keys, and denies foreign access", async () => {
    expect((await SELF.fetch("http://localhost/healthz")).status).toBe(200);

    const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: testEnv.PLATFORM_BASE_URL,
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "http://localhost/account",
      }),
    });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { url: string };
    const state = new URL(startBody.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await SELF.fetch(
      `http://localhost/api/auth/callback/github?code=provider-code&state=${encodeURIComponent(state!)}`,
      {
        headers: {
          cookie: cookiesFrom(start),
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      },
    );
    expect(callback.status).toBe(302);
    const cookies = cookiesFrom(callback);
    expect(cookies).toContain("better-auth.session_token=");

    const current = await SELF.fetch("http://localhost/api/auth/get-session", {
      headers: { cookie: cookies, origin: testEnv.PLATFORM_BASE_URL },
    });
    expect(current.status).toBe(200);
    const session = (await current.json()) as {
      user?: { id: string; email: string };
      session?: { id: string };
    };
    expect(session.user?.id).toBeTruthy();
    expect(session.user?.email).toBe("probe@example.test");
    expect(session.session?.id).toBeTruthy();

    const users = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, email FROM user",
    ).all<{ id: string; email: string }>();
    const accounts = await testEnv.IDENTITY_DB.prepare(
      "SELECT providerId, accountId FROM account",
    ).all<{ providerId: string; accountId: string }>();
    const sessions = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, userId FROM session",
    ).all<{ id: string; userId: string }>();
    expect(users.results).toHaveLength(1);
    expect(accounts.results).toEqual([
      { providerId: "github", accountId: "812345" },
    ]);
    expect(sessions.results).toHaveLength(1);
    expect(sessions.results[0]?.userId).toBe(users.results[0]?.id);

    const firstMe = await SELF.fetch("http://localhost/api/me", {
      headers: { cookie: cookies },
    });
    const secondMe = await SELF.fetch("http://localhost/api/me", {
      headers: { cookie: cookies },
    });
    const owner = (await firstMe.json()) as {
      userId: string;
      organizationId: string;
      membershipId: string;
    };
    const retryOwner = (await secondMe.json()) as typeof owner;
    expect(firstMe.status).toBe(200);
    expect(secondMe.status).toBe(200);
    expect(retryOwner).toEqual(owner);
    const organizations = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM organization WHERE id = ?",
    )
      .bind(owner.organizationId)
      .all();
    const memberships = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, role FROM member WHERE id = ? AND userId = ?",
    )
      .bind(owner.membershipId, owner.userId)
      .all<{ id: string; role: string }>();
    const receipts = await testEnv.IDENTITY_DB.prepare(
      "SELECT user_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(owner.userId)
      .all();
    expect(organizations.results).toHaveLength(1);
    expect(memberships.results).toEqual([
      { id: owner.membershipId, role: "owner" },
    ]);
    expect(receipts.results).toHaveLength(1);

    const service: TestService = {
      serviceId: "fixture-resource-service",
      audience: "https://fixture.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    const otherService: TestService = {
      serviceId: "fixture-other-service",
      audience: "https://other.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    await registerTestService(testEnv.IDENTITY_DB, otherService);

    const issued = await issueCredential(cookies, service.serviceId);
    const secondIssued = await issueCredential(cookies, service.serviceId);
    const wrongAudienceIssued = await issueCredential(
      cookies,
      otherService.serviceId,
    );
    const storedSecret = await testEnv.IDENTITY_DB.prepare(
      "SELECT credential_hash FROM platform_credential WHERE id = ?",
    )
      .bind(issued.credentialId)
      .first<{ credential_hash: string }>();
    expect(storedSecret?.credential_hash).not.toBe(issued.credential);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(
      90 * 24 * 60 * 60 * 1000,
    );

    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at) VALUES (?, 'organization', ?, ?), (?, 'organization', 'org_other_tenant', ?)",
    )
      .bind(
        "owned-resource",
        owner.organizationId,
        Date.now(),
        "foreign-resource",
        Date.now(),
      )
      .run();

    const sharedClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: requestFetch,
    });
    const authenticated = await sharedClient.authenticate(issued.credential);
    expect(authenticated.status).toBe("authenticated");
    if (authenticated.status === "authenticated") {
      expect(authenticated.principal.kind).toBe("human");
      if (authenticated.principal.kind === "human") {
        expect(authenticated.principal.organizationId).toBe(
          owner.organizationId,
        );
        expect(authenticated.principal.membershipId).toBe(owner.membershipId);
      }
    }
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), owner.organizationId)
      .run();
    expect(
      (await sharedClient.authenticate(secondIssued.credential)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
    )
      .bind(owner.organizationId)
      .run();
    expect(
      (await sharedClient.authenticate(secondIssued.credential)).status,
    ).toBe("authenticated");

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), owner.userId)
      .run();
    expect(
      (await sharedClient.authenticate(secondIssued.credential)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(owner.userId)
      .run();
    expect(
      (await sharedClient.authenticate(secondIssued.credential)).status,
    ).toBe("authenticated");

    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "owned-resource",
          issued.credential,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "foreign-resource",
          issued.credential,
        )
      ).status,
    ).toBe(404);
    expect(
      (await sharedClient.authenticate(wrongAudienceIssued.credential)).status,
    ).toBe("invalid_credential");
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "owned-resource",
          issued.credential,
          {
            authority: "wrong-platform-authority",
          },
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "owned-resource",
          issued.credential,
          {
            fetch: async () => {
              throw new Error("Platform unavailable");
            },
          },
        )
      ).status,
    ).toBe(503);

    const rejectedAuthentication = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.guestGrantIssuer,
      fetch: requestFetch,
    });
    expect(
      (await rejectedAuthentication.authenticate(issued.credential)).status,
    ).toBe("authority_unavailable");

    const bootstrap = await SELF.fetch("http://localhost/api/guest/bootstrap", {
      method: "POST",
      headers: { origin: testEnv.PLATFORM_BASE_URL },
    });
    expect(bootstrap.status).toBe(201);
    const guest = (await bootstrap.json()) as {
      guestId: string;
      credential: string;
    };
    const otherBootstrap = await SELF.fetch(
      "http://localhost/api/guest/bootstrap",
      {
        method: "POST",
        headers: { origin: testEnv.PLATFORM_BASE_URL },
      },
    );
    expect(otherBootstrap.status).toBe(201);
    const otherGuest = (await otherBootstrap.json()) as {
      guestId: string;
      credential: string;
    };
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at) VALUES (?, 'guest', ?, ?), (?, 'guest', ?, ?)",
    )
      .bind(
        "guest-resource",
        guest.guestId,
        Date.now(),
        "guest-other-resource",
        otherGuest.guestId,
        Date.now(),
      )
      .run();
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "guest-resource",
          guest.credential,
        )
      ).status,
    ).toBe(401);

    const guestGrantConfig = {
      database: testEnv.IDENTITY_DB,
      platformBaseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      guestGrantIssuer: service.guestGrantIssuer,
      fetch: requestFetch,
    };
    expect(
      await attestGuestResource(
        { ...guestGrantConfig, guestGrantIssuer: service.verifier },
        {
          guestCredential: guest.credential,
          resourceId: "guest-resource",
          capabilities: ["resource:read"],
        },
      ),
    ).toBeNull();
    expect(
      await attestGuestResource(guestGrantConfig, {
        guestCredential: guest.credential,
        resourceId: "guest-resource",
        capabilities: ["resource:admin"],
      }),
    ).toBeNull();
    const guestGrant = await attestGuestResource(guestGrantConfig, {
      guestCredential: guest.credential,
      resourceId: "guest-resource",
      capabilities: ["resource:read"],
    });
    expect(guestGrant).toBeTruthy();
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "guest-resource",
          guestGrant!.credential,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "guest-other-resource",
          guestGrant!.credential,
        )
      ).status,
    ).toBe(404);
    expect(
      await attestGuestResource(guestGrantConfig, {
        guestCredential: guest.credential,
        resourceId: "guest-other-resource",
        capabilities: ["resource:read"],
      }),
    ).toBeNull();

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_guest SET disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), guest.guestId)
      .run();
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "guest-resource",
          guestGrant!.credential,
        )
      ).status,
    ).toBe(401);
    expect(
      await attestGuestResource(guestGrantConfig, {
        guestCredential: guest.credential,
        resourceId: "guest-resource",
        capabilities: ["resource:read"],
      }),
    ).toBeNull();

    const revoke = await SELF.fetch("http://localhost/api/credentials/revoke", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ credentialId: issued.credentialId }),
    });
    expect(revoke.status).toBe(200);
    expect(
      (
        await fixtureRead(
          service,
          testEnv.IDENTITY_DB,
          "owned-resource",
          issued.credential,
        )
      ).status,
    ).toBe(401);

    await testEnv.IDENTITY_DB.prepare("DELETE FROM member WHERE id = ?")
      .bind(owner.membershipId)
      .run();
    const reinitializedMe = await SELF.fetch("http://localhost/api/me", {
      headers: { cookie: cookies },
    });
    expect(reinitializedMe.status).toBe(200);
    expect(await reinitializedMe.json()).toEqual(owner);
    const removedMembership = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM member WHERE id = ?",
    )
      .bind(owner.membershipId)
      .all();
    expect(removedMembership.results).toHaveLength(0);
    expect(
      (await sharedClient.authenticate(secondIssued.credential)).status,
    ).toBe("invalid_credential");
  });
});
