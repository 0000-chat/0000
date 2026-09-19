import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformClient } from "@0000/platform-client";
import { createAuth } from "../../src/auth";
import {
  oauthProviderTokenHash,
  provisionTrustedOAuthClient,
} from "../../src/oauth-installation";
import {
  abandonOAuthRefresh,
  completeOAuthRefresh,
  prepareOAuthRefresh,
} from "../../src/oauth-refresh";
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
  scope?: string;
  beforeToken?: () => Promise<void>;
  expectedTokenStatus?: number;
}): Promise<{
  accessToken: string;
  refreshToken?: string;
  installationId: string;
}> {
  const verifier = opaqueSecret("t07-public-verifier_");
  const requestedScope = input.scope ?? "resource:read";
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: input.offline ? `${requestedScope} offline_access` : requestedScope,
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
  await input.beforeToken?.();
  const token = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenValues),
  });
  if (input.expectedTokenStatus !== undefined) {
    expect(token.status, await token.clone().text()).toBe(
      input.expectedTokenStatus,
    );
    return {
      accessToken: "",
      installationId: selectedFlow!.installation_id!,
    };
  }
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

function interleavedRefreshDatabase(
  database: D1DatabaseSession,
  onCurrentRead: () => Promise<void>,
): D1DatabaseSession {
  let callbackComplete = false;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const isCurrentRefreshRead =
      query.includes("provider_refresh.id AS provider_refresh_id") &&
      query.includes("provider_access.id AS provider_access_id");
    const wrapped = {
      bind: (...values: unknown[]) =>
        wrapStatement(statement.bind(...values), query),
      first: async <T = Record<string, unknown>>(columnName?: string) => {
        const result =
          columnName === undefined
            ? await statement.first<T>()
            : await statement.first<T>(columnName);
        if (isCurrentRefreshRead && result && !callbackComplete) {
          callbackComplete = true;
          await onCurrentRead();
        }
        return result;
      },
      run: <T = Record<string, unknown>>() => statement.run<T>(),
      all: <T = Record<string, unknown>>() => statement.all<T>(),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) =>
        statement.raw<T>(options as never),
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query), query);
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) =>
          target.batch(
            statements.map(
              (statement) => originals.get(statement) ?? statement,
            ),
          );
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as D1DatabaseSession;
}

function afterFirstBatchDatabase(
  database: D1DatabaseSession,
  afterBatch: () => Promise<void>,
): D1DatabaseSession {
  let fired = false;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (!fired) {
            fired = true;
            await afterBatch();
          }
          return result;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as D1DatabaseSession;
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
      capabilities: ["resource:read", "resource:write"],
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
        capabilities: ["resource:read", "resource:write"],
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
      `SELECT f.id AS family_id, f.state AS family_state, t.state, t.sequence,
              t.provider_refresh_row_id, t.provider_access_row_id,
              t.expires_at AS ledger_expires_at,
              c.id AS credential_id, c.expires_at AS credential_expires_at
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       LEFT JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       WHERE f.installation_id = (SELECT referenceId FROM oauthAccessToken ORDER BY createdAt DESC LIMIT 1)`,
    ).first<{
      family_id: string;
      family_state: string;
      state: string;
      sequence: number;
      provider_refresh_row_id: string;
      provider_access_row_id: string;
      ledger_expires_at: number;
      credential_id: string;
      credential_expires_at: number;
    }>();
    expect(root).toMatchObject({
      family_state: "active",
      state: "issued",
      sequence: 0,
    });
    expect(root?.credential_id).toBeTruthy();
    expect(root!.ledger_expires_at).toBeGreaterThan(
      root!.credential_expires_at,
    );

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

    const sibling = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(sibling.refreshToken).toBeTruthy();

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

    const wrongSecret = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: initial.refresh_token,
          resource: service.audience,
          client_secret: "wrong-secret",
        }),
      },
    );
    expect(wrongSecret.status).toBe(400);
    const wrongClient = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: `t07-unknown-client-${suffix}`,
          refresh_token: initial.refresh_token,
          resource: service.audience,
        }),
      },
    );
    expect(wrongClient.status).toBe(400);
    const wrongResource = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: initial.refresh_token,
          resource: `${service.audience}/foreign`,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(wrongResource.status).toBe(400);
    const foreignHash = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: `${initial.refresh_token}-foreign`,
          resource: service.audience,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(foreignHash.status).toBe(400);

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
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE oauthAccessToken SET expiresAt = ? WHERE id = ? AND refreshId = ?",
    )
      .bind(
        Date.now() - 1_000,
        root!.provider_access_row_id,
        root!.provider_refresh_row_id,
      )
      .run();
    expect((await sharedClient.authenticate(initial.access_token)).status).toBe(
      "invalid_credential",
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
    const successorExpiry = await testEnv.IDENTITY_DB.prepare(
      `SELECT t.expires_at AS ledger_expires_at,
              c.expires_at AS credential_expires_at
       FROM platform_oauth_refresh_token AS t
       JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       WHERE t.family_id = ? AND t.sequence = 1`,
    )
      .bind(root!.family_id)
      .first<{
        ledger_expires_at: number;
        credential_expires_at: number;
      }>();
    expect(successorExpiry?.ledger_expires_at).toBeGreaterThan(
      successorExpiry?.credential_expires_at ?? 0,
    );
    const secondRotation = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: successor.refresh_token,
          resource: service.audience,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(secondRotation.status, await secondRotation.clone().text()).toBe(
      200,
    );
    const second = (await secondRotation.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(
      (await sharedClient.authenticate(successor.access_token)).status,
    ).toBe("invalid_credential");
    expect((await sharedClient.authenticate(second.access_token)).status).toBe(
      "authenticated",
    );
    const thirdRotation = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: second.refresh_token,
          resource: service.audience,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(thirdRotation.status, await thirdRotation.clone().text()).toBe(200);
    const third = (await thirdRotation.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect((await sharedClient.authenticate(second.access_token)).status).toBe(
      "invalid_credential",
    );
    expect((await sharedClient.authenticate(third.access_token)).status).toBe(
      "authenticated",
    );
    const lineage = await testEnv.IDENTITY_DB.prepare(
      `SELECT COUNT(*) AS count,
              MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
       FROM platform_oauth_refresh_token WHERE family_id =
         (SELECT family_id FROM platform_oauth_refresh_token
          WHERE id = (SELECT oauth_refresh_token_id FROM platform_credential WHERE id = ?))`,
    )
      .bind(root!.credential_id)
      .first<{
        count: number;
        first_sequence: number;
        last_sequence: number;
      }>();
    expect(lineage).toEqual({
      count: 4,
      first_sequence: 0,
      last_sequence: 3,
    });
    const rotatedIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: third.access_token,
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
      "SELECT state FROM platform_oauth_refresh_family WHERE id = ?",
    )
      .bind(root!.family_id)
      .first<{ state: string }>();
    expect(family?.state).toBe("revoked");
    const replayed = await testEnv.IDENTITY_DB.prepare(
      "SELECT state FROM platform_oauth_refresh_token WHERE id = (SELECT oauth_refresh_token_id FROM platform_credential WHERE id = ?)",
    )
      .bind(root!.credential_id)
      .first<{ state: string }>();
    expect(replayed?.state).toBe("replayed");
    const siblingRefresh = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: sibling.refreshToken!,
          resource: service.audience,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(siblingRefresh.status, await siblingRefresh.clone().text()).toBe(
      200,
    );
  });

  it("refreshes after both the predecessor provider access and Platform credential expire", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-expiry-service-${suffix}`,
      audience: `https://t07-expiry-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-expiry-client-${suffix}`,
        redirectUri: `https://t07-expiry-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
        refreshEnabled: true,
      },
    );
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE oauthResource SET accessTokenTtl = 1 WHERE identifier = ?",
    )
      .bind(service.audience)
      .run();
    const issued = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    const root = await testEnv.IDENTITY_DB.prepare(
      `SELECT t.expires_at AS ledger_expires_at,
              c.expires_at AS credential_expires_at,
              access.expiresAt AS provider_access_expires
       FROM platform_oauth_refresh_token AS t
       JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       JOIN oauthAccessToken AS access ON access.id = t.provider_access_row_id
       WHERE t.installation_id = ? AND t.sequence = 0`,
    )
      .bind(issued.installationId)
      .first<{
        ledger_expires_at: number;
        credential_expires_at: number;
        provider_access_expires: number;
      }>();
    expect(root).toBeTruthy();
    expect(root!.ledger_expires_at).toBeGreaterThan(
      root!.credential_expires_at,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(root!.credential_expires_at).toBeLessThanOrEqual(Date.now());
    expect(root!.provider_access_expires).toBeLessThanOrEqual(Date.now());
    const rotated = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: issued.refreshToken!,
        resource: service.audience,
      }),
    });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
  });

  it("keeps initial zero-row and partial root publication fail-closed", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-initial-failure-service-${suffix}`,
      audience: `https://t07-initial-failure-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-initial-failure-client-${suffix}`,
        redirectUri: `https://t07-initial-failure-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "none",
        refreshEnabled: true,
      },
    );
    const zeroTriggerName = `t07_initial_zero_${suffix}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${zeroTriggerName}"
       BEFORE INSERT ON platform_oauth_refresh_family
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    let zeroIssued: Awaited<ReturnType<typeof issueHarnessFlow>>;
    try {
      zeroIssued = await issueHarnessFlow({
        cookies: user.cookies,
        userId: user.userId,
        organizationId: organization,
        client,
        audience: service.audience,
        offline: true,
        expectedTokenStatus: 503,
      });
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        `DROP TRIGGER "${zeroTriggerName}"`,
      ).run();
    }
    expect(zeroIssued!.accessToken).toBe("");
    const zeroRows = await testEnv.IDENTITY_DB.withSession("first-primary")
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM platform_oauth_refresh_family WHERE installation_id = ?) AS families,
           (SELECT COUNT(*) FROM platform_oauth_refresh_token WHERE installation_id = ?) AS ledgers,
           (SELECT COUNT(*) FROM platform_credential WHERE oauth_installation_id = ?) AS credentials,
           (SELECT COUNT(*) FROM oauthAccessToken WHERE referenceId = ? AND revoked IS NULL) AS live_access,
           (SELECT COUNT(*) FROM oauthRefreshToken WHERE referenceId = ? AND revoked IS NULL) AS live_refresh`,
      )
      .bind(
        zeroIssued!.installationId,
        zeroIssued!.installationId,
        zeroIssued!.installationId,
        zeroIssued!.installationId,
        zeroIssued!.installationId,
      )
      .first<{
        families: number;
        ledgers: number;
        credentials: number;
        live_access: number;
        live_refresh: number;
      }>();
    expect(zeroRows).toEqual({
      families: 0,
      ledgers: 0,
      credentials: 0,
      live_access: 0,
      live_refresh: 0,
    });

    const partialTriggerName = `t07_initial_partial_${suffix}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${partialTriggerName}"
       AFTER INSERT ON platform_credential
       WHEN NEW.oauth_refresh_token_id IS NOT NULL
       BEGIN
         DELETE FROM platform_credential WHERE id = NEW.id;
       END`,
    ).run();
    let partialIssued: Awaited<ReturnType<typeof issueHarnessFlow>>;
    try {
      partialIssued = await issueHarnessFlow({
        cookies: user.cookies,
        userId: user.userId,
        organizationId: organization,
        client,
        audience: service.audience,
        offline: true,
        expectedTokenStatus: 503,
      });
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        `DROP TRIGGER "${partialTriggerName}"`,
      ).run();
    }
    expect(partialIssued!.accessToken).toBe("");
    const partialRows = await testEnv.IDENTITY_DB.withSession("first-primary")
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM platform_oauth_refresh_family WHERE installation_id = ?) AS families,
           (SELECT COUNT(*) FROM platform_oauth_refresh_token WHERE installation_id = ?) AS ledgers,
           (SELECT COUNT(*) FROM platform_credential WHERE oauth_installation_id = ?) AS credentials,
           (SELECT COUNT(*) FROM oauthAccessToken WHERE referenceId = ? AND revoked IS NULL) AS live_access,
           (SELECT COUNT(*) FROM oauthRefreshToken WHERE referenceId = ? AND revoked IS NULL) AS live_refresh`,
      )
      .bind(
        partialIssued!.installationId,
        partialIssued!.installationId,
        partialIssued!.installationId,
        partialIssued!.installationId,
        partialIssued!.installationId,
      )
      .first<{
        families: number;
        ledgers: number;
        credentials: number;
        live_access: number;
        live_refresh: number;
      }>();
    expect(partialRows).toEqual({
      families: 0,
      ledgers: 0,
      credentials: 0,
      live_access: 0,
      live_refresh: 0,
    });
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
    let providerTriggerError = "";
    try {
      await testEnv.IDENTITY_DB.prepare(
        `INSERT INTO oauthRefreshToken (id, token, clientId, userId, scopes)
         VALUES (?, ?, ?, ?, '[]')`,
      )
        .bind(
          crypto.randomUUID(),
          `t07-provider-trigger-probe-${suffix}`,
          client.clientId,
          user.userId,
        )
        .run();
    } catch (error) {
      providerTriggerError = String(error);
    }
    expect(providerTriggerError).toContain(
      "t07_provider_refresh_insert_failure",
    );
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
    let mappingTriggerError = "";
    try {
      await testEnv.IDENTITY_DB.prepare(
        `INSERT INTO platform_oauth_refresh_token
         (id, family_id, installation_id, provider_refresh_row_id,
          provider_refresh_token_hash, provider_access_row_id, predecessor_id,
          predecessor_consumption_nonce, sequence, resources, capabilities,
          expires_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', '[]', ?, 'issued', ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          mappingRoot!.family_id,
          mappingIssued.installationId,
          crypto.randomUUID(),
          `t07-mapping-trigger-probe-${suffix}`,
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          Date.now() + 60_000,
          Date.now(),
          Date.now(),
        )
        .run();
    } catch (error) {
      mappingTriggerError = String(error);
    }
    expect(mappingTriggerError).toContain(
      "t07_platform_mapping_insert_failure",
    );
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

  it("denies the durable pending fence and terminalizes an ancestor replay during a later rotation", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-pending-service-${suffix}`,
      audience: `https://t07-pending-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-pending-client-${suffix}`,
        redirectUri: `https://t07-pending-client-${suffix}.example.test/callback`,
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
      `SELECT f.id AS family_id, t.id AS token_id
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE f.installation_id = ? AND t.sequence = 0`,
    )
      .bind(issued.installationId)
      .first<{ family_id: string; token_id: string }>();
    expect(root).toBeTruthy();
    const sibling = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(sibling.refreshToken).toBeTruthy();
    const firstRotation = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: issued.refreshToken!,
          resource: service.audience,
        }),
      },
    );
    expect(firstRotation.status, await firstRotation.clone().text()).toBe(200);
    const successor = (await firstRotation.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const successorRow = await testEnv.IDENTITY_DB.prepare(
      `SELECT id FROM platform_oauth_refresh_token
       WHERE family_id = ? AND sequence = 1`,
    )
      .bind(root!.family_id)
      .first<{ id: string }>();
    expect(successorRow?.id).toBeTruthy();
    const pendingNonce = crypto.randomUUID();
    await testEnv.IDENTITY_DB.prepare(
      `UPDATE platform_oauth_refresh_family
       SET state = 'pending', pending_token_id = ?,
           pending_consumption_nonce = ?, updated_at = ?
       WHERE id = ? AND state = 'active'`,
    )
      .bind(successorRow!.id, pendingNonce, Date.now(), root!.family_id)
      .run();
    const pending = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state, f.pending_token_id,
              t.state AS token_state, t.consumption_nonce
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.id = f.pending_token_id
       WHERE f.id = ?`,
    )
      .bind(root!.family_id)
      .first<{
        family_state: string;
        pending_token_id: string;
        token_state: string;
        consumption_nonce: string;
      }>();
    expect(pending).toEqual({
      family_state: "pending",
      pending_token_id: successorRow!.id,
      token_state: "pending",
      consumption_nonce: pendingNonce,
    });
    const replay = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: issued.refreshToken!,
        resource: service.audience,
      }),
    });
    expect(replay.status).toBe(400);
    const terminal = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state AS family_state,
              root.state AS root_state, pending.state AS pending_state
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS root
         ON root.family_id = f.id AND root.sequence = 0
       JOIN platform_oauth_refresh_token AS pending
         ON pending.family_id = f.id AND pending.sequence = 1
       WHERE f.id = ?`,
    )
      .bind(root!.family_id)
      .first<{
        family_state: string;
        root_state: string;
        pending_state: string;
      }>();
    expect(terminal).toEqual({
      family_state: "revoked",
      root_state: "replayed",
      pending_state: "revoked",
    });
    const siblingRefresh = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: sibling.refreshToken!,
          resource: service.audience,
        }),
      },
    );
    expect(siblingRefresh.status, await siblingRefresh.clone().text()).toBe(
      200,
    );
    expect(successor.access_token).toBeTruthy();
  });

  it("lets one concurrent predecessor consume win the D1 fence", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-race-service-${suffix}`,
      audience: `https://t07-race-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-race-client-${suffix}`,
        redirectUri: `https://t07-race-client-${suffix}.example.test/callback`,
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
    let currentReads = 0;
    let releaseReads!: () => void;
    const readsReady = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const afterRead = async () => {
      currentReads += 1;
      if (currentReads === 2) releaseReads();
      await readsReady;
    };
    const authOptions = {
      oauthPlatform: true,
      oauthGrantTypes: ["authorization_code", "refresh_token"] as [
        "authorization_code",
        "refresh_token",
      ],
      oauthScopes: ["resource:read", "offline_access"],
    };
    const request = () =>
      new Request("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: issued.refreshToken!,
          resource: service.audience,
        }),
      });
    const first = prepareOAuthRefresh(
      interleavedRefreshDatabase(
        testEnv.IDENTITY_DB.withSession("first-primary"),
        afterRead,
      ),
      createAuth(testEnv, authOptions),
      request(),
    );
    const second = prepareOAuthRefresh(
      interleavedRefreshDatabase(
        testEnv.IDENTITY_DB.withSession("first-primary"),
        afterRead,
      ),
      createAuth(testEnv, authOptions),
      request(),
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(currentReads).toBe(2);
    const preparations = [firstResult, secondResult];
    expect(
      preparations.filter((result) => result.kind === "refresh").length,
    ).toBe(1);
    expect(
      preparations.filter(
        (result) =>
          result.kind === "response" && result.response.status === 503,
      ).length,
    ).toBe(1);
    const winner = preparations.find(
      (result): result is Extract<typeof result, { kind: "refresh" }> =>
        result.kind === "refresh",
    );
    expect(winner).toBeTruthy();
    await abandonOAuthRefresh(
      testEnv.IDENTITY_DB.withSession("first-primary"),
      winner!,
      "t07_concurrent_test_cleanup",
    );
    const family = await testEnv.IDENTITY_DB.prepare(
      `SELECT f.state, t.state AS token_state
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.id = ? AND t.family_id = f.id
       WHERE f.id = ?`,
    )
      .bind(winner!.tokenId, winner!.familyId)
      .first<{ state: string; token_state: string }>();
    expect(family).toEqual({
      state: "quarantined",
      token_state: "quarantined",
    });
  });

  it("withholds a mapped successor when authority changes before delivery", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-late-authority-service-${suffix}`,
      audience: `https://t07-late-authority-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-late-authority-client-${suffix}`,
        redirectUri: `https://t07-late-authority-client-${suffix}.example.test/callback`,
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
    const sibling = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    const authOptions = {
      oauthPlatform: true,
      oauthGrantTypes: ["authorization_code", "refresh_token"] as [
        "authorization_code",
        "refresh_token",
      ],
      oauthScopes: ["resource:read", "offline_access"],
    };
    const request = () =>
      new Request("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: issued.refreshToken!,
          resource: service.audience,
        }),
      });
    const preparation = await prepareOAuthRefresh(
      testEnv.IDENTITY_DB.withSession("first-primary"),
      createAuth(testEnv, authOptions),
      request(),
    );
    expect(preparation.kind).toBe("refresh");
    if (preparation.kind !== "refresh") return;
    const providerResponse = await createAuth(testEnv, authOptions).handler(
      request(),
    );
    expect(providerResponse.status).toBe(200);
    let authorityChanged = false;
    const completed = await completeOAuthRefresh(
      afterFirstBatchDatabase(
        testEnv.IDENTITY_DB.withSession("first-primary"),
        async () => {
          authorityChanged = true;
          const disabled = await testEnv.IDENTITY_DB.prepare(
            "UPDATE platform_service SET disabled = 1 WHERE service_id = ?",
          )
            .bind(service.serviceId)
            .run();
          expect(disabled.meta.changes).toBe(1);
        },
      ),
      providerResponse,
      preparation,
      client.clientId,
    );
    expect(authorityChanged).toBe(true);
    expect(completed.status).toBe(503);
    expect(
      (await completed.json()) as { access_token?: string },
    ).not.toHaveProperty("access_token");
    const successor = await testEnv.IDENTITY_DB.prepare(
      `SELECT t.state, c.revoked_at
       FROM platform_oauth_refresh_token AS t
       LEFT JOIN platform_credential AS c ON c.oauth_refresh_token_id = t.id
       WHERE t.family_id = (SELECT family_id FROM platform_oauth_refresh_token
                            WHERE installation_id = ? AND sequence = 0)
         AND t.sequence = 1`,
    )
      .bind(issued.installationId)
      .first<{ state: string; revoked_at: number | null }>();
    expect(successor).toEqual(expect.objectContaining({ state: "revoked" }));
    expect(successor?.revoked_at).not.toBeNull();
    const family = await testEnv.IDENTITY_DB.prepare(
      `SELECT state FROM platform_oauth_refresh_family WHERE installation_id = ?`,
    )
      .bind(issued.installationId)
      .first<{ state: string }>();
    expect(family?.state).toBe("quarantined");

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET disabled = 0 WHERE service_id = ?",
    )
      .bind(service.serviceId)
      .run();
    const siblingRefresh = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: sibling.refreshToken!,
          resource: service.audience,
        }),
      },
    );
    expect(siblingRefresh.status, await siblingRefresh.clone().text()).toBe(
      200,
    );
  });

  it("keeps a failed quarantine durably pending across a fresh D1 session", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-quarantine-service-${suffix}`,
      audience: `https://t07-quarantine-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-quarantine-client-${suffix}`,
        redirectUri: `https://t07-quarantine-client-${suffix}.example.test/callback`,
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
      `SELECT f.id AS family_id, t.id AS token_id
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
       WHERE f.installation_id = ? AND t.sequence = 0`,
    )
      .bind(issued.installationId)
      .first<{ family_id: string; token_id: string }>();
    expect(root).toBeTruthy();
    const sibling = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(sibling.refreshToken).toBeTruthy();
    const mappingTriggerName = `t07_abort_quarantine_mapping_${suffix}`;
    const quarantineTriggerName = `t07_abort_quarantine_write_${suffix}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${mappingTriggerName}"
       BEFORE INSERT ON platform_oauth_refresh_token
       WHEN NEW.predecessor_id IS NOT NULL
       BEGIN
         SELECT RAISE(ABORT, 't07_quarantine_mapping_failure');
       END`,
    ).run();
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${quarantineTriggerName}"
       BEFORE UPDATE OF state ON platform_oauth_refresh_family
       WHEN NEW.state = 'quarantined'
       BEGIN
         SELECT RAISE(ABORT, 't07_quarantine_write_failure');
       END`,
    ).run();
    let quarantineTriggerError = "";
    try {
      await testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_oauth_refresh_family SET state = 'quarantined' WHERE id = ?",
      )
        .bind(root!.family_id)
        .run();
    } catch (error) {
      quarantineTriggerError = String(error);
    }
    expect(quarantineTriggerError).toContain("t07_quarantine_write_failure");
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
      await testEnv.IDENTITY_DB.batch([
        testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${mappingTriggerName}"`),
        testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${quarantineTriggerName}"`),
      ]);
    }
    expect(failed!.status).toBe(503);
    const durable = await testEnv.IDENTITY_DB.withSession("first-primary")
      .prepare(
        `SELECT f.state AS family_state, i.active,
                t.state AS token_state, f.pending_token_id
         FROM platform_oauth_refresh_family AS f
         JOIN platform_oauth_installation AS i ON i.id = f.installation_id
         JOIN platform_oauth_refresh_token AS t ON t.id = f.pending_token_id
         WHERE f.id = ?`,
      )
      .bind(root!.family_id)
      .first<{
        family_state: string;
        active: number;
        token_state: string;
        pending_token_id: string;
      }>();
    expect(durable).toEqual({
      family_state: "pending",
      active: 1,
      token_state: "pending",
      pending_token_id: root!.token_id,
    });
    const retry = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: issued.refreshToken!,
        resource: service.audience,
      }),
    });
    expect(retry.status).toBe(503);
    const siblingRefresh = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: sibling.refreshToken!,
          resource: service.audience,
        }),
      },
    );
    expect(siblingRefresh.status, await siblingRefresh.clone().text()).toBe(
      200,
    );
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

  it("denies refresh after each current-authority change without revoking the issued predecessor", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t07-authority-service-${suffix}`,
      audience: `https://t07-authority-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const organization = await organizationId(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        clientId: `t07-authority-client-${suffix}`,
        redirectUri: `https://t07-authority-client-${suffix}.example.test/callback`,
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
      `SELECT f.id AS family_id, f.membership_id, t.id AS token_id,
              t.provider_refresh_row_id, t.provider_access_row_id,
              m.role, m.createdAt AS membership_created_at
       FROM platform_oauth_refresh_family AS f
       JOIN platform_oauth_refresh_token AS t ON t.family_id = f.id
        AND t.sequence = 0
       JOIN member AS m ON m.id = f.membership_id
       WHERE f.installation_id = ?`,
    )
      .bind(issued.installationId)
      .first<{
        family_id: string;
        membership_id: string;
        token_id: string;
        provider_refresh_row_id: string;
        provider_access_row_id: string;
        role: string;
        membership_created_at: number;
      }>();
    expect(root).toBeTruthy();
    const refresh = () =>
      SELF.fetch("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: issued.refreshToken!,
          resource: service.audience,
        }),
      });
    const assertUnchanged = async () => {
      const state = await testEnv.IDENTITY_DB.prepare(
        `SELECT f.state AS family_state, t.state AS token_state,
                access.revoked AS access_revoked,
                refresh.revoked AS refresh_revoked
         FROM platform_oauth_refresh_family AS f
         JOIN platform_oauth_refresh_token AS t ON t.id = ?
         JOIN oauthAccessToken AS access ON access.id = ?
         JOIN oauthRefreshToken AS refresh ON refresh.id = ?
         WHERE f.id = ?`,
      )
        .bind(
          root!.token_id,
          root!.provider_access_row_id,
          root!.provider_refresh_row_id,
          root!.family_id,
        )
        .first<{
          family_state: string;
          token_state: string;
          access_revoked: number | null;
          refresh_revoked: number | null;
        }>();
      expect(state).toEqual({
        family_state: "active",
        token_state: "issued",
        access_revoked: null,
        refresh_revoked: null,
      });
    };

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), organization)
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
    )
      .bind(organization)
      .run();

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET allowed_capabilities = '[]' WHERE service_id = ?",
    )
      .bind(service.serviceId)
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET allowed_capabilities = ? WHERE service_id = ?",
    )
      .bind(JSON.stringify(service.capabilities), service.serviceId)
      .run();

    const consent = await testEnv.IDENTITY_DB.prepare(
      `SELECT id, clientId, userId, referenceId, resources,
              requestedUserInfoClaims, scopes, createdAt, updatedAt
       FROM oauthConsent WHERE referenceId = ?`,
    )
      .bind(issued.installationId)
      .first<{
        id: string;
        clientId: string;
        userId: string;
        referenceId: string;
        resources: string | null;
        requestedUserInfoClaims: string | null;
        scopes: string;
        createdAt: number | null;
        updatedAt: number | null;
      }>();
    expect(consent).toBeTruthy();
    await testEnv.IDENTITY_DB.prepare(
      "DELETE FROM oauthConsent WHERE referenceId = ?",
    )
      .bind(issued.installationId)
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO oauthConsent
         (id, clientId, userId, referenceId, resources,
          requestedUserInfoClaims, scopes, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        consent!.id,
        consent!.clientId,
        consent!.userId,
        consent!.referenceId,
        consent!.resources,
        consent!.requestedUserInfoClaims,
        consent!.scopes,
        consent!.createdAt,
        consent!.updatedAt,
      )
      .run();

    const healthyBeforeUserDisable = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(healthyBeforeUserDisable.refreshToken).toBeTruthy();

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), user.userId)
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(user.userId)
      .run();

    const healthyBeforeMemberRemoval = await issueHarnessFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: organization,
      client,
      audience: service.audience,
      offline: true,
    });
    expect(healthyBeforeMemberRemoval.refreshToken).toBeTruthy();
    await testEnv.IDENTITY_DB.prepare("DELETE FROM member WHERE id = ?")
      .bind(root!.membership_id)
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        organization,
        user.userId,
        root!.role,
        root!.membership_created_at,
      )
      .run();
    expect((await refresh()).status).toBe(503);
    await assertUnchanged();
  });
});
