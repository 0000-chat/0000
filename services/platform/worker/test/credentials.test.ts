import { createPlatformClient } from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { opaqueSecret } from "../../src/platform-state";
import {
  disableService,
  registerService,
  rotateServiceVerifier,
  updateServiceMetadata,
} from "../../src/service-registration";
import { handleResourceRequest } from "./fixtures/resource-service";
import { registerTestService, type TestService } from "./fixtures/provision";

type MutableTestEnv = Omit<
  Cloudflare.Env,
  "PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS"
> & {
  PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: string;
};

const testEnv = env as MutableTestEnv;

function cookiesFrom(response: Response): string {
  const all = response.headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  return all
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function login(): Promise<{
  cookie: string;
  userId: string;
  organizationId: string;
  membershipId: string;
}> {
  const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "http://localhost/account",
    }),
  });
  const state = new URL(
    ((await start.json()) as { url: string }).url,
  ).searchParams.get("state");
  if (!state) throw new Error("provider state missing");
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/github?code=credentials-test&state=${encodeURIComponent(state)}`,
    {
      headers: {
        cookie: cookiesFrom(start),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
  const cookie = cookiesFrom(callback);
  const me = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie },
  });
  const owner = (await me.json()) as {
    userId: string;
    organizationId: string;
    membershipId: string;
  };
  return { cookie, ...owner };
}

async function issue(
  user: { cookie: string; organizationId: string },
  service: TestService,
  options: {
    capabilities?: string[];
    lifetimeDays?: unknown;
    name?: string;
  } = {},
): Promise<Response> {
  return SELF.fetch("http://localhost/api/credentials", {
    method: "POST",
    headers: {
      cookie: user.cookie,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      serviceId: service.serviceId,
      organizationId: user.organizationId,
      capabilities: options.capabilities ?? ["resource:read"],
      name: options.name ?? "Credentials test key",
      ...(Object.hasOwn(options, "lifetimeDays")
        ? { lifetimeDays: options.lifetimeDays }
        : {}),
    }),
  });
}

function sharedClient(
  service: TestService,
  fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    SELF.fetch(input, init),
) {
  return createPlatformClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    fetch,
  });
}

async function fixtureRead(
  service: TestService,
  credential: string,
  resourceId: string,
): Promise<Response> {
  return handleResourceRequest(
    new Request(`http://fixture.test/resources/${resourceId}`, {
      headers: { authorization: `Bearer ${credential}` },
    }),
    {
      database: testEnv.IDENTITY_DB,
      platformBaseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      guestGrantIssuer: service.guestGrantIssuer,
      fetch: (input, init) => SELF.fetch(input, init),
    },
  );
}

describe("T04 human credentials and registered resource audiences", () => {
  beforeEach(async () => {
    const { vi } = await import("vitest");
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
            access_token: "credentials-provider-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: 912345,
            login: "credentials-test",
            name: "Credentials Test",
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            {
              email: "credentials-test@example.test",
              primary: true,
              verified: true,
            },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
    testEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "90";
  });

  it("issues one-time human keys and proves two live audience boundaries through the shared client", async () => {
    const user = await login();
    const first: TestService = {
      serviceId: "t04-resource-one",
      audience: "https://resource-one.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read", "resource:write"],
    };
    const second: TestService = {
      serviceId: "t04-resource-two",
      audience: "https://resource-two.0000.test/mcp",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, first);
    await registerTestService(testEnv.IDENTITY_DB, second);
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience) VALUES (?, 'organization', ?, ?, ?), (?, 'organization', ?, ?, ?)",
    )
      .bind(
        "t04-resource-one-row",
        user.organizationId,
        Date.now(),
        first.audience,
        "t04-resource-two-row",
        user.organizationId,
        Date.now(),
        second.audience,
      )
      .run();

    const issuedResponse = await issue(user, first, {
      name: "Read and write",
      capabilities: ["resource:read", "resource:write"],
    });
    expect(issuedResponse.status).toBe(201);
    const issued = (await issuedResponse.json()) as {
      credential: string;
      credentialId: string;
      expiresAt: number;
    };
    expect(issued.credential).toMatch(/^0000_/);
    expect(issued.expiresAt - Date.now()).toBeLessThanOrEqual(
      90 * 24 * 60 * 60 * 1000,
    );
    const raw = await testEnv.IDENTITY_DB.prepare(
      "SELECT credential_hash, name, audience, capabilities, expires_at FROM platform_credential WHERE id = ?",
    )
      .bind(issued.credentialId)
      .first<{
        credential_hash: string;
        name: string;
        audience: string;
        capabilities: string;
        expires_at: number;
      }>();
    expect(raw?.credential_hash).not.toContain(issued.credential);
    expect(raw?.name).toBe("Read and write");
    expect(raw?.audience).toBe(first.audience);
    expect(JSON.parse(raw?.capabilities ?? "[]")).toEqual([
      "resource:read",
      "resource:write",
    ]);
    expect(raw?.expires_at).toBe(issued.expiresAt);

    const listing = await SELF.fetch(
      `http://localhost/api/credentials?organizationId=${encodeURIComponent(user.organizationId)}`,
      { headers: { cookie: user.cookie } },
    );
    expect(listing.status).toBe(200);
    const listingText = await listing.text();
    expect(listingText).not.toContain(issued.credential);
    expect(JSON.parse(listingText)).toMatchObject({
      organizationId: user.organizationId,
      credentials: [
        {
          id: issued.credentialId,
          name: "Read and write",
          audience: first.audience,
        },
      ],
    });

    const firstClient = sharedClient(first);
    const secondClient = sharedClient(second);
    expect((await firstClient.authenticate(issued.credential)).status).toBe(
      "authenticated",
    );
    expect(
      (await fixtureRead(first, issued.credential, "t04-resource-one-row"))
        .status,
    ).toBe(200);
    expect(
      (await fixtureRead(second, issued.credential, "t04-resource-two-row"))
        .status,
    ).toBe(401);
    expect((await secondClient.authenticate(issued.credential)).status).toBe(
      "invalid_credential",
    );
    expect(
      (await fixtureRead(first, issued.credential, "t04-resource-two-row"))
        .status,
    ).toBe(404);

    const verifierAttempt = await SELF.fetch(
      "http://localhost/api/credentials",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.verifier}`,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceId: first.serviceId,
          organizationId: user.organizationId,
          capabilities: ["resource:read"],
        }),
      },
    );
    expect(verifierAttempt.status).toBe(401);

    const short = await issue(user, first, { lifetimeDays: 1 });
    expect(short.status).toBe(201);
    const shortBody = (await short.json()) as {
      expiresAt: number;
      credential: string;
    };
    expect(shortBody.expiresAt - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
    for (const lifetimeDays of [0, -1, Number.POSITIVE_INFINITY, "1"]) {
      const invalid = await issue(user, first, { lifetimeDays });
      expect(invalid.status).toBe(400);
    }

    const account = await SELF.fetch("http://localhost/account", {
      headers: { cookie: user.cookie },
    });
    const accountHtml = await account.text();
    expect(account.status).toBe(200);
    expect(accountHtml).toContain("Personal API credentials");
    expect(accountHtml).not.toContain(issued.credential);
    testEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "NaN";
    const invalidConfiguration = await issue(user, first);
    expect(invalidConfiguration.status).toBe(503);
    const invalidConfigurationAccount = await SELF.fetch(
      `http://localhost/account?organizationId=${encodeURIComponent(user.organizationId)}`,
      { headers: { cookie: user.cookie } },
    );
    const invalidConfigurationHtml = await invalidConfigurationAccount.text();
    expect(invalidConfigurationAccount.status).toBe(200);
    expect(invalidConfigurationHtml).toContain("Read and write");
    expect(invalidConfigurationHtml).toContain(
      "Credential issuance and rotation are unavailable",
    );
    expect(invalidConfigurationHtml).toContain(
      `data-revoke-credential="${issued.credentialId}"`,
    );
    const invalidConfigurationListing = await SELF.fetch(
      `http://localhost/api/credentials?organizationId=${encodeURIComponent(user.organizationId)}`,
      { headers: { cookie: user.cookie } },
    );
    expect(invalidConfigurationListing.status).toBe(200);
    expect(await invalidConfigurationListing.text()).toContain(
      issued.credentialId,
    );
    const invalidConfigurationRevoke = await SELF.fetch(
      "http://localhost/api/credentials/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: user.organizationId,
          credentialId: issued.credentialId,
        }),
      },
    );
    expect(invalidConfigurationRevoke.status).toBe(200);
    expect((await firstClient.authenticate(issued.credential)).status).toBe(
      "invalid_credential",
    );
    testEnv.PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS = "90";
  });

  it("rotates atomically, revokes idempotently, respects catalog changes, and retires verifier state", async () => {
    const user = await login();
    const service: TestService = {
      serviceId: "t04-lifecycle-service",
      audience: "https://lifecycle.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read", "resource:write"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    const issuedResponse = await issue(user, service, {
      capabilities: ["resource:read", "resource:write"],
      name: "Lifecycle key",
    });
    const issued = (await issuedResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const rotate = async () =>
      SELF.fetch("http://localhost/api/credentials/rotate", {
        method: "POST",
        headers: {
          cookie: user.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: user.organizationId,
          credentialId: issued.credentialId,
        }),
      });
    const races = await Promise.all([rotate(), rotate()]);
    expect(races.map((response) => response.status).sort()).toEqual([201, 409]);
    const replacementResponse = races.find(
      (response) => response.status === 201,
    );
    if (!replacementResponse) throw new Error("rotation winner missing");
    const replacement = (await replacementResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const rows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, revoked_at, replaced_by_id, predecessor_id FROM platform_credential WHERE id IN (?, ?)",
    )
      .bind(issued.credentialId, replacement.credentialId)
      .all<{
        id: string;
        revoked_at: number | null;
        replaced_by_id: string | null;
        predecessor_id: string | null;
      }>();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.find((row) => row.id === issued.credentialId)
        ?.replaced_by_id,
    ).toBe(replacement.credentialId);
    expect(
      rows.results.find((row) => row.id === replacement.credentialId)
        ?.predecessor_id,
    ).toBe(issued.credentialId);
    expect(
      (await sharedClient(service).authenticate(issued.credential)).status,
    ).toBe("invalid_credential");
    expect(
      (await sharedClient(service).authenticate(replacement.credential)).status,
    ).toBe("authenticated");

    const revoke = await SELF.fetch("http://localhost/api/credentials/revoke", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: user.organizationId,
        credentialId: replacement.credentialId,
      }),
    });
    expect(revoke.status).toBe(200);
    const revokeAgain = await SELF.fetch(
      "http://localhost/api/credentials/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: user.organizationId,
          credentialId: replacement.credentialId,
        }),
      },
    );
    expect(revokeAgain.status).toBe(200);
    expect(
      (await sharedClient(service).authenticate(replacement.credential)).status,
    ).toBe("invalid_credential");

    const catalogCredentialResponse = await issue(user, service, {
      capabilities: ["resource:write"],
    });
    expect(catalogCredentialResponse.status).toBe(201);
    const catalogCredential = (await catalogCredentialResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: service.serviceId,
      capabilities: ["resource:read"],
      displayName: "Narrowed service",
    });
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT allowed_capabilities FROM platform_service WHERE service_id = ?",
      )
        .bind(service.serviceId)
        .first<{ allowed_capabilities: string }>(),
    ).toEqual({ allowed_capabilities: '["resource:read"]' });
    expect(
      (await sharedClient(service).authenticate(catalogCredential.credential))
        .status,
    ).toBe("invalid_credential");
    await updateServiceMetadata(testEnv.IDENTITY_DB, {
      serviceId: service.serviceId,
      capabilities: ["resource:read", "resource:write", "resource:admin"],
      displayName: "Expanded service",
    });
    expect(
      (await sharedClient(service).authenticate(catalogCredential.credential))
        .status,
    ).toBe("authenticated");
    const expandedIssue = await issue(user, service, {
      capabilities: ["resource:admin"],
    });
    expect(expandedIssue.status).toBe(201);
    const oldVerifier = service.verifier;
    const newVerifier = await rotateServiceVerifier(
      testEnv.IDENTITY_DB,
      service.serviceId,
    );
    expect(
      (await sharedClient(service).authenticate(catalogCredential.credential))
        .status,
    ).toBe("authority_unavailable");
    expect(
      (
        await createPlatformClient({
          baseUrl: testEnv.PLATFORM_BASE_URL,
          authority: testEnv.PLATFORM_AUTHORITY_ID,
          audience: service.audience,
          serviceVerifier: newVerifier,
          fetch: (input, init) => SELF.fetch(input, init),
        }).authenticate(catalogCredential.credential)
      ).status,
    ).toBe("authenticated");
    expect(
      (
        await createPlatformClient({
          baseUrl: testEnv.PLATFORM_BASE_URL,
          authority: testEnv.PLATFORM_AUTHORITY_ID,
          audience: service.audience,
          serviceVerifier: oldVerifier,
          fetch: (input, init) => SELF.fetch(input, init),
        }).authenticate(catalogCredential.credential)
      ).status,
    ).toBe("authority_unavailable");
    expect(await disableService(testEnv.IDENTITY_DB, service.serviceId)).toBe(
      true,
    );
    expect(
      (
        await sharedClient({ ...service, verifier: newVerifier }).authenticate(
          catalogCredential.credential,
        )
      ).status,
    ).toBe("authority_unavailable");
  });

  it("rolls back an injected rotation failure and serializes rotation versus revoke", async () => {
    const user = await login();
    const service: TestService = {
      serviceId: "t04-atomic-service",
      audience: "https://atomic.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    const failedResponse = await issue(user, service, {
      name: "Injected failure",
    });
    const failed = (await failedResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER t04_fail_rotation
         BEFORE INSERT ON platform_credential
         WHEN NEW.predecessor_id = '${failed.credentialId}'
         BEGIN SELECT RAISE(ABORT, 'injected rotation failure'); END;`,
    ).run();
    const failedRotation = await SELF.fetch(
      "http://localhost/api/credentials/rotate",
      {
        method: "POST",
        headers: {
          cookie: user.cookie,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: user.organizationId,
          credentialId: failed.credentialId,
        }),
      },
    );
    expect(failedRotation.status).toBe(503);
    const unchanged = await testEnv.IDENTITY_DB.prepare(
      "SELECT revoked_at, replaced_by_id FROM platform_credential WHERE id = ?",
    )
      .bind(failed.credentialId)
      .first<{ revoked_at: number | null; replaced_by_id: string | null }>();
    expect(unchanged).toEqual({ revoked_at: null, replaced_by_id: null });
    await testEnv.IDENTITY_DB.prepare("DROP TRIGGER t04_fail_rotation").run();
    expect(
      (await sharedClient(service).authenticate(failed.credential)).status,
    ).toBe("authenticated");

    const racedResponse = await issue(user, service, {
      name: "Rotation revoke race",
    });
    const raced = (await racedResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const rotate = SELF.fetch("http://localhost/api/credentials/rotate", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: user.organizationId,
        credentialId: raced.credentialId,
      }),
    });
    const revoke = SELF.fetch("http://localhost/api/credentials/revoke", {
      method: "POST",
      headers: {
        cookie: user.cookie,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        organizationId: user.organizationId,
        credentialId: raced.credentialId,
      }),
    });
    const [rotationResult, revokeResult] = await Promise.all([rotate, revoke]);
    expect([201, 409]).toContain(rotationResult.status);
    expect(revokeResult.status).toBe(200);
    const raceRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, revoked_at, replaced_by_id FROM platform_credential WHERE id = ? OR predecessor_id = ?",
    )
      .bind(raced.credentialId, raced.credentialId)
      .all<{
        id: string;
        revoked_at: number | null;
        replaced_by_id: string | null;
      }>();
    expect(
      raceRows.results.filter((row) => row.revoked_at === null),
    ).toHaveLength(rotationResult.status === 201 ? 1 : 0);
    expect(
      (await sharedClient(service).authenticate(raced.credential)).status,
    ).toBe("invalid_credential");
  });
});
