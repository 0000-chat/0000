import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformClient } from "@0000/platform-client";
import {
  oauthProviderTokenHash,
  provisionTrustedOAuthClient,
} from "../../src/oauth-installation";
import { opaqueSecret } from "../../src/platform-state";
import { registerService } from "../../src/service-registration";

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

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function challenge(value: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

async function signIn(): Promise<{ cookies: string; userId: string }> {
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
  const state = new URL(
    ((await start.json()) as { url: string }).url,
  ).searchParams.get("state");
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/github?code=t07-refresh-code&state=${encodeURIComponent(state!)}`,
    { headers: { cookie: cookiesFrom(start) }, redirect: "manual" },
  );
  const cookies = cookiesFrom(callback);
  const session = await SELF.fetch("http://localhost/api/auth/get-session", {
    headers: { cookie: cookies },
  });
  return {
    cookies,
    userId: ((await session.json()) as { user: { id: string } }).user.id,
  };
}

async function organizationId(cookies: string): Promise<string> {
  const response = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie: cookies },
  });
  return ((await response.json()) as { organizationId: string }).organizationId;
}

async function issueHarnessFlow(input: {
  cookies: string;
  userId: string;
  organizationId: string;
  client: Awaited<ReturnType<typeof provisionTrustedOAuthClient>>;
  audience: string;
  offline: boolean;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  installationId: string;
}> {
  const verifier = opaqueSecret("t07-public-verifier_");
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: input.offline ? "resource:read offline_access" : "resource:read",
    resource: input.audience,
    state: crypto.randomUUID(),
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  });
  const authorize = await SELF.fetch(
    `http://localhost/api/auth/oauth2/authorize?${query}`,
    { headers: { cookie: input.cookies }, redirect: "manual" },
  );
  expect(authorize.status).toBe(302);
  const selection = new URL(
    authorize.headers.get("location")!,
    "http://localhost",
  );
  expect(
    (await SELF.fetch(selection, { headers: { cookie: input.cookies } }))
      .status,
  ).toBe(200);
  const flow = await testEnv.IDENTITY_DB.prepare(
    "SELECT id FROM platform_oauth_flow WHERE user_id = ? AND state = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(input.userId, query.get("state"))
    .first<{ id: string }>();
  expect(flow).toBeTruthy();
  const selected = await SELF.fetch("http://localhost/oauth2/selection", {
    method: "POST",
    headers: {
      cookie: input.cookies,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      flowId: flow!.id,
      organizationId: input.organizationId,
    }),
    redirect: "manual",
  });
  expect(selected.status).toBe(303);
  const selectedFlow = await testEnv.IDENTITY_DB.prepare(
    "SELECT id, status, installation_id, oauth_query FROM platform_oauth_flow WHERE id = ?",
  )
    .bind(flow!.id)
    .first<{
      id: string;
      status: string;
      installation_id: string | null;
      oauth_query: string;
    }>();
  const continued = await SELF.fetch(selected.headers.get("location")!, {
    headers: { cookie: input.cookies },
    redirect: "manual",
  });
  expect(continued.status).toBe(302);
  const consentLocation = new URL(
    continued.headers.get("location")!,
    "http://localhost",
  );
  const consent = await SELF.fetch("http://localhost/api/auth/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: input.cookies,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentLocation.search.slice(1),
    }),
  });
  expect(consent.status).toBe(200);
  const consentBody = (await consent.json()) as {
    redirect_uri?: string;
    url?: string;
  };
  const callback = new URL(
    consentBody.redirect_uri ?? consentBody.url ?? "",
    "http://localhost",
  );
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenValues: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    code: code!,
    code_verifier: verifier,
    resource: input.audience,
  };
  if (input.client.clientSecret)
    tokenValues.client_secret = input.client.clientSecret;
  const token = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenValues),
  });
  expect(token.status, await token.clone().text()).toBe(200);
  const body = (await token.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  const access = await testEnv.IDENTITY_DB.prepare(
    "SELECT referenceId FROM oauthAccessToken WHERE token = ? LIMIT 1",
  )
    .bind(await oauthProviderTokenHash(body.access_token))
    .first<{ referenceId: string }>();
  expect(access?.referenceId).toBeTruthy();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    installationId: access!.referenceId,
  };
}

describe("T07 production OAuth refresh lineage", () => {
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
            access_token: "t07-social-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: 817001,
            login: "t07-refresh-user",
            name: "T07 Refresh User",
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            {
              email: "t07-refresh@example.test",
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
  });

  it("publishes the root, rotates once, verifies the successor, and terminally handles replay", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-refresh-service-${suffix}`,
      audience: `https://t07-refresh-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-refresh-client-${suffix}`,
        redirectUri: `https://t07-refresh-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "client_secret_post",
        refreshEnabled: true,
      },
    );
    const verifier = opaqueSecret("t07-refresh-verifier_");
    const query = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: client.redirectUri,
      scope: "resource:read offline_access",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    });
    const authorize = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${query}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const selection = new URL(
      authorize.headers.get("location")!,
      "http://localhost",
    );
    await SELF.fetch(selection, { headers: { cookie: user.cookies } });
    const flow = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM platform_oauth_flow WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(user.userId)
      .first<{ id: string }>();
    expect(flow).toBeTruthy();
    const selected = await SELF.fetch("http://localhost/oauth2/selection", {
      method: "POST",
      headers: {
        cookie: user.cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        flowId: flow!.id,
        organizationId: organization,
      }),
      redirect: "manual",
    });
    expect(selected.status).toBe(303);
    const continued = await SELF.fetch(selected.headers.get("location")!, {
      headers: { cookie: user.cookies },
      redirect: "manual",
    });
    const consentLocation = new URL(
      continued.headers.get("location")!,
      "http://localhost",
    );
    const consent = await SELF.fetch(
      "http://localhost/api/auth/oauth2/consent",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentLocation.search.slice(1),
        }),
      },
    );
    expect(consent.status).toBe(200);
    const consentBody = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const callback = new URL(
      consentBody.redirect_uri ?? consentBody.url ?? "",
      "http://localhost",
    );
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code: code!,
        code_verifier: verifier,
        resource: service.audience,
        client_secret: client.clientSecret!,
      }),
    });
    expect(token.status, await token.clone().text()).toBe(200);
    const initial = (await token.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(initial.refresh_token).toBeTruthy();
    const root = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state, t.state, t.sequence, t.provider_refresh_row_id,
              t.provider_access_row_id,
              c.id AS credential_id
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       LEFT JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       WHERE f.installation_id = (SELECT referenceId FROM oauthAccessToken ORDER BY createdAt DESC LIMIT 1)`,
    ).first<{
      family_state: string;
      state: string;
      sequence: number;
      provider_refresh_row_id: string;
      provider_access_row_id: string;
      credential_id: string;
    }>();
    expect(root).toMatchObject({
      family_state: "active",
      state: "issued",
      sequence: 0,
    });
    expect(root?.credential_id).toBeTruthy();

    const rejectedScope = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: initial.refresh_token,
          resource: service.audience,
          scope: "resource:write",
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(rejectedScope.status).toBe(400);
    const untouched = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state, t.state
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE t.id = (SELECT oauth_refresh_token_id FROM platform_credential WHERE id = ?)`,
    )
      .bind(root!.credential_id)
      .first<{ family_state: string; state: string }>();
    expect(untouched).toEqual({ family_state: "active", state: "issued" });

    const introspection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: initial.access_token,
        }),
      },
    );
    expect(introspection.status).toBe(200);
    expect((await introspection.json()) as { active: boolean }).toMatchObject({
      active: true,
    });
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_oauth_client SET capabilities = ? WHERE client_id = ?",
    )
      .bind("[]", client.clientId)
      .run();
    const narrowedIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: initial.access_token,
        }),
      },
    );
    expect(narrowedIntrospection.status).toBe(200);
    expect(
      (await narrowedIntrospection.json()) as { active: boolean },
    ).toMatchObject({
      active: false,
    });
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_oauth_client SET capabilities = ? WHERE client_id = ?",
    )
      .bind(JSON.stringify(service.capabilities), client.clientId)
      .run();

    await testEnv.IDENTITY_DB.prepare(
      `DELETE FROM platform_oauth_flow
       WHERE installation_id = (SELECT installation_id FROM platform_oauth_refresh_family WHERE id =
         (SELECT family_id FROM platform_oauth_refresh_token WHERE id =
           (SELECT oauth_refresh_token_id FROM platform_credential WHERE id = ?)))`,
    )
      .bind(root!.credential_id)
      .run();

    const sharedClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: SELF.fetch,
    });
    await testEnv.IDENTITY_DB.prepare("DELETE FROM session WHERE userId = ?")
      .bind(user.userId)
      .run();
    expect((await sharedClient.authenticate(initial.access_token)).status).toBe(
      "authenticated",
    );
    const rotated = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: initial.refresh_token,
        resource: service.audience,
        client_secret: client.clientSecret!,
      }),
    });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    const successor = (await rotated.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(successor.refresh_token).toBeTruthy();
    expect((await sharedClient.authenticate(initial.access_token)).status).toBe(
      "invalid_credential",
    );
    expect(
      (await sharedClient.authenticate(successor.access_token)).status,
    ).toBe("authenticated");
    const rotatedIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: successor.access_token,
        }),
      },
    );
    expect(rotatedIntrospection.status).toBe(200);
    expect(
      (await rotatedIntrospection.json()) as { active: boolean },
    ).toMatchObject({ active: true });
    await testEnv.IDENTITY_DB.batch([
      testEnv.IDENTITY_DB.prepare(
        "DELETE FROM oauthAccessToken WHERE id = ? AND refreshId = ?",
      ).bind(root!.provider_access_row_id, root!.provider_refresh_row_id),
      testEnv.IDENTITY_DB.prepare(
        "DELETE FROM oauthRefreshToken WHERE id = ?",
      ).bind(root!.provider_refresh_row_id),
    ]);
    const replay = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: initial.refresh_token,
        resource: service.audience,
        client_secret: client.clientSecret!,
      }),
    });
    expect(replay.status).toBe(400);
    const family = await testEnv.IDENTITY_DB.prepare(
      "SELECT state FROM platform_oauth_refresh_family ORDER BY created_at DESC LIMIT 1",
    ).first<{ state: string }>();
    expect(family?.state).toBe("revoked");
    const replayed = await testEnv.IDENTITY_DB.prepare(
      "SELECT state FROM platform_oauth_refresh_token WHERE id = (SELECT oauth_refresh_token_id FROM platform_credential WHERE id = ?)",
    )
      .bind(root!.credential_id)
      .first<{ state: string }>();
    expect(replayed?.state).toBe("replayed");
  });

  it("keeps public refresh opt-in access-only when offline_access is absent", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-public-service-${suffix}`,
      audience: `https://t07-public-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-public-client-${suffix}`,
        redirectUri: `https://t07-public-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
        refreshEnabled: true,
      },
    );
    const offline = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(offline.refreshToken).toBeTruthy();
    const family = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM platform_oauth_refresh_family WHERE installation_id = ?",
    )
      .bind(offline.installationId)
      .first<{ id: string }>();
    expect(family?.id).toBeTruthy();

    const accessOnly = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: false,
    });
    expect(accessOnly.refreshToken).toBeUndefined();
    const noFamily = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM platform_oauth_refresh_family WHERE installation_id = ?",
    )
      .bind(accessOnly.installationId)
      .first<{ id: string }>();
    expect(noFamily).toBeNull();
    const providerAccess = await testEnv.IDENTITY_DB.prepare(
      "SELECT refreshId FROM oauthAccessToken WHERE referenceId = ? ORDER BY createdAt DESC LIMIT 1",
    )
      .bind(accessOnly.installationId)
      .first<{ refreshId: string | null }>();
    expect(providerAccess?.refreshId).toBeNull();

    const codeOnlyClient = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-code-only-client-${suffix}`,
        redirectUri: `https://t07-code-only-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
      },
    );
    const rejectedRefresh = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: codeOnlyClient.clientId,
          refresh_token: "unknown-refresh-token",
          resource: service.audience,
        }),
      },
    );
    expect(rejectedRefresh.status).toBe(400);
    expect((await rejectedRefresh.json()) as { error?: string }).toMatchObject({
      error: "unsupported_grant_type",
    });
  });

  it("keeps provider and Platform mapping failures fail-closed after the consume fence", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-failure-service-${suffix}`,
      audience: `https://t07-failure-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-failure-client-${suffix}`,
        redirectUri: `https://t07-failure-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
        refreshEnabled: true,
      },
    );
    const issued = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    const root = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.id AS family_id, t.id AS token_id, t.provider_refresh_row_id
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE f.installation_id = ? AND t.sequence = 0`,
    )
      .bind(issued.installationId)
      .first<{
        family_id: string;
        token_id: string;
        provider_refresh_row_id: string;
      }>();
    expect(root).toBeTruthy();
    const triggerName = `t07_abort_provider_${suffix}`;
    const escapedClientId = client.clientId.replaceAll("'", "''");
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${triggerName}"
       BEFORE INSERT ON oauthRefreshToken
       WHEN NEW.clientId = '${escapedClientId}'
       BEGIN
         SELECT RAISE(ABORT, 't07_provider_refresh_insert_failure');
       END`,
    ).run();
    let failed: Response;
    try {
      failed = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: issued.refreshToken!,
          resource: service.audience,
        }),
      });
    } finally {
      await testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${triggerName}"`).run();
    }
    expect(failed!.status).toBe(503);
    const state = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state, i.active,
              t.state AS token_state, COUNT(all_tokens.id) AS token_count
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_installation AS i ON i.id = f.installation_id
       JOIN platform_oauth_refresh_token AS t ON t.id = ?
       LEFT JOIN platform_oauth_refresh_token AS all_tokens ON all_tokens.family_id = f.id
       WHERE f.id = ?
       GROUP BY f.state, i.active, t.state`,
    )
      .bind(root!.token_id, root!.family_id)
      .first<{
        family_state: string;
        active: number;
        token_state: string;
        token_count: number;
      }>();
    expect(state).toEqual({
      family_state: "quarantined",
      active: 0,
      token_state: "quarantined",
      token_count: 1,
    });
    const providerRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM oauthRefreshToken WHERE clientId = ?",
    )
      .bind(client.clientId)
      .first<{ count: number }>();
    expect(providerRows?.count).toBe(1);

    const mappingIssued = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    const mappingRoot = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.id AS family_id, t.id AS token_id
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE f.installation_id = ? AND t.sequence = 0`,
    )
      .bind(mappingIssued.installationId)
      .first<{
        family_id: string;
        token_id: string;
      }>();
    expect(mappingRoot).toBeTruthy();
    const mappingTriggerName = `t07_abort_mapping_${suffix}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${mappingTriggerName}"
       BEFORE INSERT ON platform_oauth_refresh_token
       WHEN NEW.predecessor_id IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 't07_platform_mapping_insert_failure');
       END`,
    ).run();
    let mappingFailed: Response;
    try {
      mappingFailed = await SELF.fetch(
        "http://localhost/api/auth/oauth2/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: client.clientId,
            refresh_token: mappingIssued.refreshToken!,
            resource: service.audience,
          }),
        },
      );
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        `DROP TRIGGER "${mappingTriggerName}"`,
      ).run();
    }
    expect(mappingFailed!.status).toBe(503);
    const mappingState = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state, i.active,
              t.state AS token_state, COUNT(all_tokens.id) AS token_count
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_installation AS i ON i.id = f.installation_id
       JOIN platform_oauth_refresh_token AS t ON t.id = ?
       LEFT JOIN platform_oauth_refresh_token AS all_tokens ON all_tokens.family_id = f.id
       WHERE f.id = ?
       GROUP BY f.state, i.active, t.state`,
    )
      .bind(mappingRoot!.token_id, mappingRoot!.family_id)
      .first<{
        family_state: string;
        active: number;
        token_state: string;
        token_count: number;
      }>();
    expect(mappingState).toEqual({
      family_state: "quarantined",
      active: 0,
      token_state: "quarantined",
      token_count: 1,
    });
    const mappingSuccessor = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_oauth_refresh_token WHERE family_id = ?",
    )
      .bind(mappingRoot!.family_id)
      .first<{ count: number }>();
    expect(mappingSuccessor?.count).toBe(1);
    const mappingProviderRows = await testEnv.IDENTITY_DB.prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN revoked IS NULL THEN 1 ELSE 0 END) AS active
       FROM oauthRefreshToken WHERE clientId = ? AND referenceId = ?`,
    )
      .bind(client.clientId, mappingIssued.installationId)
      .first<{
        count: number;
        active: number;
      }>();
    expect(mappingProviderRows).toEqual({ count: 2, active: 0 });
  });

  it("lists installations without secrets and provides session-only terminal revoke", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-account-service-${suffix}`,
      audience: `https://t07-account-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-account-client-${suffix}`,
        redirectUri: `https://t07-account-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
        refreshEnabled: true,
      },
    );
    const issued = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });

    const accountPage = await SELF.fetch("http://localhost/account", {
      headers: { cookie: user.cookies },
    });
    expect(accountPage.status).toBe(200);
    expect(await accountPage.text()).toContain("Harness installations");

    const listed = await SELF.fetch(
      `http://localhost/api/account/oauth-installations?organizationId=${encodeURIComponent(organization)}`,
      { headers: { cookie: user.cookies } },
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      installations: Array<Record<string, unknown>>;
    };
    const listedInstallation = listBody.installations.find(
      (installation) => installation.id === issued.installationId,
    );
    expect(listedInstallation).toMatchObject({
      id: issued.installationId,
      client_id: client.clientId,
      service_id: service.serviceId,
      organization_id: organization,
    });
    expect(JSON.stringify(listBody)).not.toContain("refresh_token");
    expect(JSON.stringify(listBody)).not.toContain("provider_row");

    const machineList = await SELF.fetch(
      `http://localhost/api/account/oauth-installations?organizationId=${encodeURIComponent(organization)}`,
      { headers: { authorization: `Bearer ${service.verifier}` } },
    );
    expect(machineList.status).toBe(401);

    const untrusted = await SELF.fetch(
      "http://localhost/api/account/oauth-installations/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: issued.installationId,
          organizationId: organization,
        }),
      },
    );
    expect(untrusted.status).toBe(403);

    const revoke = await SELF.fetch(
      "http://localhost/api/account/oauth-installations/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: issued.installationId,
          organizationId: organization,
        }),
      },
    );
    expect(revoke.status).toBe(200);
    const again = await SELF.fetch(
      "http://localhost/api/account/oauth-installations/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ installationId: issued.installationId }),
      },
    );
    expect(again.status).toBe(200);
    const durable = await testEnv.IDENTITY_DB.prepare(
      `SELECT i.active, f.state AS family_state, t.state AS token_state
       FROM platform_oauth_installation AS i
       JOIN platform_oauth_refresh_family AS f ON f.installation_id = i.id
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE i.id = ? AND t.sequence = 0`,
    )
      .bind(issued.installationId)
      .first<{ active: number; family_state: string; token_state: string }>();
    expect(durable).toEqual({
      active: 0,
      family_state: "revoked",
      token_state: "revoked",
    });
    const denied = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: issued.refreshToken!,
        resource: service.audience,
      }),
    });
    expect(denied.status).toBe(400);
  });
});
