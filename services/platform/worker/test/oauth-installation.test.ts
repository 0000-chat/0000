import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeInitialOAuthAccess,
  prepareTrustedOAuthClientRegistration,
  provisionTrustedOAuthClient,
  trustedOAuthClientStatements,
  validateTrustedOAuthClientInput,
} from "../../src/oauth-installation";
import { createAuth } from "../../src/auth";
import { registerService } from "../../src/service-registration";
import { opaqueSecret } from "../../src/platform-state";
import { createPlatformClient } from "@0000/platform-client";

const testEnv = env as Cloudflare.Env;
let currentProfile = {
  id: 816345,
  login: "t06-user",
  email: "t06@example.test",
};

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

async function challenge(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function interleavedOAuthAuthorityDatabase(
  database: D1Database,
  afterAuthorityRead: () => Promise<void>,
): D1Database {
  let callbackComplete = false;
  const originalStatements = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement => {
    const isAuthorityLookup =
      query.includes("SELECT member.id, pc.redirect_uri") &&
      query.includes("FROM member JOIN organization") &&
      query.includes("JOIN platform_oauth_client AS pc");
    const wrapped = {
      bind: (...values: unknown[]) =>
        wrapStatement(statement.bind(...values), query),
      first: async <T = Record<string, unknown>>(columnName?: string) => {
        const result =
          columnName === undefined
            ? await statement.first<T>()
            : await statement.first<T>(columnName);
        if (isAuthorityLookup && result && !callbackComplete) {
          callbackComplete = true;
          await afterAuthorityRead();
        }
        return result;
      },
      run: <T = Record<string, unknown>>() => statement.run<T>(),
      all: <T = Record<string, unknown>>() => statement.all<T>(),
      raw: <T = unknown[]>(options?: { columnNames?: boolean }) =>
        statement.raw<T>(options as never),
    } as unknown as D1PreparedStatement;
    originalStatements.set(wrapped, statement);
    return wrapped;
  };
  const wrapSession = (session: D1DatabaseSession): D1DatabaseSession =>
    new Proxy(session, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => wrapStatement(target.prepare(query), query);
        }
        if (property === "batch") {
          return (statements: D1PreparedStatement[]) =>
            target.batch(
              statements.map(
                (statement) => originalStatements.get(statement) ?? statement,
              ),
            );
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as D1DatabaseSession;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "withSession") {
        return (constraint: string) =>
          wrapSession(target.withSession(constraint as never));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as D1Database;
}

async function signIn(
  profile: {
    id: number;
    login: string;
    email: string;
  },
  callbackURL = "http://localhost/account",
): Promise<{
  cookies: string;
  userId: string;
  callbackLocation: string | null;
}> {
  currentProfile = profile;
  const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: testEnv.PLATFORM_BASE_URL,
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL,
    }),
  });
  const startBody = (await start.json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/github?code=provider-code&state=${encodeURIComponent(state!)}`,
    {
      headers: { cookie: cookiesFrom(start) },
      redirect: "manual",
    },
  );
  expect(callback.status).toBe(302);
  const cookies = cookiesFrom(callback);
  const session = await SELF.fetch("http://localhost/api/auth/get-session", {
    headers: { cookie: cookies },
  });
  const body = (await session.json()) as { user: { id: string } };
  return {
    cookies,
    userId: body.user.id,
    callbackLocation: callback.headers.get("location"),
  };
}

async function ownerOrganization(cookies: string): Promise<string> {
  const response = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie: cookies },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { organizationId: string }).organizationId;
}

async function beginSelection(input: {
  cookies: string;
  userId: string;
  client: Awaited<ReturnType<typeof provisionTrustedOAuthClient>>;
  audience: string;
  scope?: string;
}): Promise<{
  flowId: string;
  verifier: string;
  query: URLSearchParams;
}> {
  const verifier = opaqueSecret("t06-negative-verifier_");
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: input.scope ?? "resource:read",
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
  expect(selection.pathname).toBe("/oauth2/selection");
  const page = await SELF.fetch(selection, {
    headers: { cookie: input.cookies },
  });
  expect(page.status).toBe(200);
  const flow = await testEnv.IDENTITY_DB.prepare(
    "SELECT id FROM platform_oauth_flow WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(input.userId)
    .first<{ id: string }>();
  expect(flow).toBeTruthy();
  return { flowId: flow!.id, verifier, query };
}

async function selectFlow(input: {
  cookies: string;
  flowId: string;
  organizationId: string;
  origin?: string;
}): Promise<Response> {
  return SELF.fetch("http://localhost/oauth2/selection", {
    method: "POST",
    headers: {
      cookie: input.cookies,
      origin: input.origin ?? testEnv.PLATFORM_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      flowId: input.flowId,
      organizationId: input.organizationId,
    }),
    redirect: "manual",
  });
}

async function continueFlow(
  cookies: string,
  flowId: string,
): Promise<Response> {
  return SELF.fetch(`http://localhost/oauth2/continue?flow_id=${flowId}`, {
    headers: { cookie: cookies },
    redirect: "manual",
  });
}

async function submitBrowserConsent(
  cookies: string,
  flowId: string,
  accept: boolean,
): Promise<{
  response: Response;
  location: URL;
  pageText: string;
  pageHeaders: Headers;
}> {
  const continued = await continueFlow(cookies, flowId);
  expect(continued.status).toBe(302);
  const location = new URL(
    continued.headers.get("location")!,
    "http://localhost",
  );
  const page = await SELF.fetch(location, { headers: { cookie: cookies } });
  expect(page.status).toBe(200);
  const pageText = await page.text();
  const response = await SELF.fetch(
    "http://localhost/api/auth/oauth2/consent",
    {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        accept: String(accept),
        oauth_query: location.search.slice(1),
        flow_id: flowId,
      }),
      redirect: "manual",
    },
  );
  return { response, location, pageText, pageHeaders: page.headers };
}

async function completeFlow(input: {
  cookies: string;
  userId: string;
  organizationId: string;
  client: Awaited<ReturnType<typeof provisionTrustedOAuthClient>>;
  audience: string;
  clientSecret?: string;
}): Promise<{ accessToken: string; verifier: string; code: string }> {
  const verifier = opaqueSecret("t06-flow-verifier_");
  const query = new URLSearchParams({
    client_id: input.client.clientId,
    response_type: "code",
    redirect_uri: input.client.redirectUri,
    scope: "resource:read",
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
  await SELF.fetch(`http://localhost${selection.pathname}${selection.search}`, {
    headers: { cookie: input.cookies },
  });
  const flow = await testEnv.IDENTITY_DB.prepare(
    "SELECT id FROM platform_oauth_flow WHERE user_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(input.userId)
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
  const continued = await SELF.fetch(
    `http://localhost${new URL(selected.headers.get("location")!).pathname}${new URL(selected.headers.get("location")!).search}`,
    { headers: { cookie: input.cookies }, redirect: "manual" },
  );
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
  if (input.clientSecret) tokenValues.client_secret = input.clientSecret;
  const token = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(tokenValues),
  });
  expect(token.status, await token.clone().text()).toBe(200);
  const tokenBody = (await token.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  expect(tokenBody.access_token).toBeTruthy();
  expect(tokenBody.refresh_token).toBeUndefined();
  return { accessToken: tokenBody.access_token, verifier, code: code! };
}

describe("T06 production OAuth installation", () => {
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
            id: currentProfile.id,
            login: currentProfile.login,
            name: "T06 User",
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            { email: currentProfile.email, primary: true, verified: true },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("runs a public PKCE consent flow and binds an opaque shared credential", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-oauth-service",
      audience: "https://t06-oauth.0000.test",
      capabilities: ["resource:read"],
    });
    const operator = await signIn({
      id: 816344,
      login: "t06-operator",
      email: "operator-t06@example.test",
    });
    const user = await signIn({
      id: 816345,
      login: "t06-consenter",
      email: "consenter-t06@example.test",
    });
    const organizationId = await ownerOrganization(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-client.example.test/callback",
        capabilities: ["resource:read"],
        authMethod: "none",
        ownerUserId: operator.userId,
      },
    );
    const metadata = await SELF.fetch(
      "http://localhost/.well-known/oauth-authorization-server",
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
    const unauthenticatedVerifier = opaqueSecret("t06-unauth-verifier_");
    const unauthenticatedQuery = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: client.redirectUri,
      scope: "resource:read",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(unauthenticatedVerifier),
      code_challenge_method: "S256",
    });
    const unauthenticatedAuthorize = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${unauthenticatedQuery}`,
      { redirect: "manual" },
    );
    expect(unauthenticatedAuthorize.status).toBe(302);
    const loginLocation = new URL(
      unauthenticatedAuthorize.headers.get("location")!,
      "http://localhost",
    );
    expect(loginLocation.pathname).toBe("/login");
    const loginPage = await SELF.fetch(loginLocation, { redirect: "manual" });
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('id="oauth-query"');

    const failedLoginStart = await SELF.fetch(
      "http://localhost/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: testEnv.PLATFORM_BASE_URL,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
          errorCallbackURL: "http://localhost/login",
          disableRedirect: true,
        }),
      },
    );
    expect(failedLoginStart.status).toBe(200);
    const failedLoginState = new URL(
      ((await failedLoginStart.json()) as { url: string }).url,
    ).searchParams.get("state");
    expect(failedLoginState).toBeTruthy();
    const failedLoginCallback = await SELF.fetch(
      `http://localhost/api/auth/callback/github?error=access_denied&state=${encodeURIComponent(failedLoginState!)}`,
      {
        headers: { cookie: cookiesFrom(failedLoginStart) },
        redirect: "manual",
      },
    );
    expect(failedLoginCallback.status).toBe(302);
    const failedLoginLocation = new URL(
      failedLoginCallback.headers.get("location")!,
    );
    expect(failedLoginLocation.pathname).toBe("/login");
    expect(failedLoginLocation.searchParams.get("error")).toBe("access_denied");
    const failedLoginPage = await SELF.fetch(failedLoginLocation);
    expect(failedLoginPage.status).toBe(200);
    expect(await failedLoginPage.text()).not.toContain('id="oauth-query"');
    const retryStart = await SELF.fetch(
      "http://localhost/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: testEnv.PLATFORM_BASE_URL,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
          errorCallbackURL: "http://localhost/login",
          disableRedirect: true,
        }),
      },
    );
    expect(retryStart.status).toBe(200);
    const malformedRetry = await SELF.fetch(
      "http://localhost/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: testEnv.PLATFORM_BASE_URL,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/oauth2/selection?error=access_denied",
        }),
      },
    );
    expect(malformedRetry.status).toBe(400);
    expect(await malformedRetry.json()).toEqual({
      error: "invalid_callback_destination",
    });
    const resumed = await signIn(
      {
        id: 816345,
        login: "t06-consenter",
        email: "consenter-t06@example.test",
      },
      `http://localhost/oauth2/selection${loginLocation.search}`,
    );
    expect(
      new URL(resumed.callbackLocation!, "http://localhost").pathname,
    ).toBe("/oauth2/selection");
    const resumedSelection = await SELF.fetch(
      new URL(resumed.callbackLocation!, "http://localhost"),
      { headers: { cookie: resumed.cookies } },
    );
    expect(resumedSelection.status).toBe(200);
    expect(await resumedSelection.text()).toContain("Choose access");
    const verifier = opaqueSecret("t06-verifier_");
    const query = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: client.redirectUri,
      scope: "resource:read",
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
    expect(selection.pathname).toBe("/oauth2/selection");
    const selectionPage = await SELF.fetch(
      `http://localhost${selection.pathname}${selection.search}`,
      { headers: { cookie: user.cookies } },
    );
    expect(selectionPage.status).toBe(200);
    const selected = await SELF.fetch("http://localhost/oauth2/selection", {
      method: "POST",
      headers: {
        cookie: user.cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        flowId: (await testEnv.IDENTITY_DB.prepare(
          "SELECT id FROM platform_oauth_flow ORDER BY created_at DESC LIMIT 1",
        ).first<{ id: string }>())!.id,
        organizationId,
      }),
      redirect: "manual",
    });
    expect(selected.status).toBe(303);
    const continued = await SELF.fetch(
      `http://localhost${new URL(selected.headers.get("location")!).pathname}${new URL(selected.headers.get("location")!).search}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect(continued.status).toBe(302);
    const consentUrl = new URL(
      continued.headers.get("location")!,
      "http://localhost",
    );
    expect(consentUrl.pathname).toBe("/consent");
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
          oauth_query: consentUrl.search.slice(1),
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
      }),
    });
    expect(token.status, await token.clone().text()).toBe(200);
    const tokenBody = (await token.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeUndefined();
    const credential = await testEnv.IDENTITY_DB.prepare(
      `SELECT credential_hash, oauth_origin, oauth_provider_row_id
       FROM platform_credential WHERE oauth_origin = 'better-auth' ORDER BY created_at DESC LIMIT 1`,
    ).first<{
      credential_hash: string;
      oauth_origin: string;
      oauth_provider_row_id: string;
    }>();
    expect(credential?.oauth_origin).toBe("better-auth");
    expect(credential?.oauth_provider_row_id).toBeTruthy();
    const sharedClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: SELF.fetch,
    });
    const authenticated = await sharedClient.authenticate(
      tokenBody.access_token,
    );
    expect(authenticated.status, JSON.stringify(authenticated)).toBe(
      "authenticated",
    );
    const refresh = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: "not-issued",
      }),
    });
    expect(refresh.status).toBe(400);
    expect((await refresh.json()) as { error: string }).toMatchObject({
      error: "unsupported_grant_type",
    });
    const signOut = await SELF.fetch("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: user.cookies,
        origin: testEnv.PLATFORM_BASE_URL,
      },
    });
    expect(signOut.status).toBe(200);
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("authenticated");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), organizationId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
    )
      .bind(organizationId)
      .run();
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), user.userId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(user.userId)
      .run();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET allowed_capabilities = ? WHERE service_id = ?",
    )
      .bind(JSON.stringify(["resource:write"]), service.serviceId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET allowed_capabilities = ? WHERE service_id = ?",
    )
      .bind(JSON.stringify(["resource:read"]), service.serviceId)
      .run();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_oauth_client SET capabilities = ? WHERE client_id = ?",
    )
      .bind("[]", client.clientId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_oauth_client SET capabilities = ? WHERE client_id = ?",
    )
      .bind(JSON.stringify(["resource:read"]), client.clientId)
      .run();
    const consentScopes = await testEnv.IDENTITY_DB.prepare(
      "SELECT scopes FROM oauthConsent WHERE clientId = ? AND userId = ? ORDER BY createdAt DESC LIMIT 1",
    )
      .bind(client.clientId, user.userId)
      .first<{ scopes: string }>();
    expect(consentScopes?.scopes).toBeTruthy();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE oauthConsent SET scopes = ? WHERE clientId = ? AND userId = ?",
    )
      .bind("[]", client.clientId, user.userId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE oauthConsent SET scopes = ? WHERE clientId = ? AND userId = ?",
    )
      .bind(consentScopes!.scopes, client.clientId, user.userId)
      .run();
    const installation = await testEnv.IDENTITY_DB.prepare(
      "SELECT membership_id FROM platform_oauth_installation WHERE active = 1 LIMIT 1",
    ).first<{ membership_id: string }>();
    expect(installation).toBeTruthy();
    const operatorMembershipId = crypto.randomUUID();
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
    )
      .bind(operatorMembershipId, organizationId, operator.userId, Date.now())
      .run();
    const leaveSession = await signIn({
      id: 816345,
      login: "t06-consenter",
      email: "consenter-t06@example.test",
    });
    const leave = await SELF.fetch(
      "http://localhost/api/account/members/leave",
      {
        method: "POST",
        headers: {
          cookie: leaveSession.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ organizationId }),
      },
    );
    expect(leave.status, await leave.clone().text()).toBe(200);
    expect(
      await testEnv.IDENTITY_DB.prepare("SELECT id FROM member WHERE id = ?")
        .bind(installation!.membership_id)
        .first(),
    ).toBeNull();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
    )
      .bind(crypto.randomUUID(), organizationId, user.userId, Date.now())
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
    const replaySession = await signIn({
      id: 816345,
      login: "t06-consenter",
      email: "consenter-t06@example.test",
    });
    const replayOrganizationId = await ownerOrganization(replaySession.cookies);
    const replayBefore = await testEnv.IDENTITY_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM platform_credential AS credential
       JOIN platform_oauth_installation AS installation
         ON installation.id = credential.oauth_installation_id
       WHERE installation.client_id = ? AND installation.user_id = ?`,
    )
      .bind(client.clientId, user.userId)
      .first<{ count: number }>();
    const replayBeforeCount = replayBefore?.count ?? -1;
    expect(replayBeforeCount).toBe(1);
    const replayFlow = await completeFlow({
      cookies: replaySession.cookies,
      userId: user.userId,
      organizationId: replayOrganizationId,
      client,
      audience: service.audience,
    });
    const replay = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        code: replayFlow.code,
        code_verifier: replayFlow.verifier,
        resource: service.audience,
      }),
    });
    expect(replay.status).toBe(400);
    expect(
      (await replay.json()) as { access_token?: string },
    ).not.toHaveProperty("access_token");
    const replayAfter = await testEnv.IDENTITY_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM platform_credential AS credential
       JOIN platform_oauth_installation AS installation
         ON installation.id = credential.oauth_installation_id
       WHERE installation.client_id = ? AND installation.user_id = ?`,
    )
      .bind(client.clientId, user.userId)
      .first<{ count: number }>();
    expect(replayAfter?.count).toBe(replayBeforeCount + 1);
  });

  it("rejects forged, cross-session, expired and denied installation flows", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-negative-service",
      audience: "https://t06-negative.0000.test",
      capabilities: ["resource:read"],
    });
    const operator = await signIn({
      id: 816348,
      login: "t06-negative-operator",
      email: "operator-negative-t06@example.test",
    });
    const user = await signIn({
      id: 816349,
      login: "t06-negative-user",
      email: "user-negative-t06@example.test",
    });
    const secondSession = await signIn({
      id: 816349,
      login: "t06-negative-user",
      email: "user-negative-t06@example.test",
    });
    const foreign = await signIn({
      id: 816350,
      login: "t06-negative-foreign",
      email: "foreign-negative-t06@example.test",
    });
    const organizationId = await ownerOrganization(user.cookies);
    const secondOrganizationId = crypto.randomUUID();
    const secondMembershipId = crypto.randomUUID();
    await testEnv.IDENTITY_DB.batch([
      testEnv.IDENTITY_DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(
        secondOrganizationId,
        "T06 second organization",
        `t06-second-${crypto.randomUUID()}`,
        Date.now(),
      ),
      testEnv.IDENTITY_DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind(secondMembershipId, secondOrganizationId, user.userId, Date.now()),
    ]);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-negative-client.example.test/callback",
        capabilities: ["resource:read"],
        authMethod: "none",
        ownerUserId: operator.userId,
      },
    );

    const verifier = opaqueSecret("t06-invalid-request_");
    const baseRequest = {
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: client.redirectUri,
      scope: "resource:read",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    };
    for (const [label, overrides] of [
      ["wrong redirect", { redirect_uri: "https://attacker.example/callback" }],
      ["wrong resource", { resource: "https://other-service.0000.test" }],
      ["excess scope", { scope: "resource:write" }],
      ["wrong client", { client_id: "platform-oauth-unknown" }],
    ] as const) {
      const rejected = await SELF.fetch(
        `http://localhost/api/auth/oauth2/authorize?${new URLSearchParams({
          ...baseRequest,
          ...overrides,
          state: `${label}-${crypto.randomUUID()}`,
        })}`,
        { headers: { cookie: user.cookies }, redirect: "manual" },
      );
      expect([302, 400], label).toContain(rejected.status);
      if (rejected.status === 302) {
        const errorLocation = new URL(
          rejected.headers.get("location") ?? "http://invalid.test",
        );
        expect(errorLocation.searchParams.get("error"), label).toBeTruthy();
      }
    }
    const alias = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize/?${new URLSearchParams(baseRequest)}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect(alias.status).toBe(404);
    const tokenAlias = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token/?grant_type=refresh_token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: "not-issued",
        }),
      },
    );
    expect(tokenAlias.status).toBe(404);

    const pending = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: secondSession.cookies,
          flowId: pending.flowId,
          organizationId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await selectFlow({
          cookies: foreign.cookies,
          flowId: pending.flowId,
          organizationId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: pending.flowId,
          organizationId,
          origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    const concurrentSelections = await Promise.all(
      [organizationId, secondOrganizationId].map(
        async (selectedOrganizationId) => ({
          organizationId: selectedOrganizationId,
          response: await selectFlow({
            cookies: user.cookies,
            flowId: pending.flowId,
            organizationId: selectedOrganizationId,
          }),
        }),
      ),
    );
    expect(
      concurrentSelections.map(({ response }) => response.status).sort(),
    ).toEqual([303, 409]);
    const winner = concurrentSelections.find(
      ({ response }) => response.status === 303,
    );
    expect(winner).toBeTruthy();
    const winnerLocation = new URL(
      winner!.response.headers.get("location")!,
      "http://localhost",
    );
    expect(winnerLocation.searchParams.get("flow_id")).toBe(pending.flowId);
    const persistedWinner = await testEnv.IDENTITY_DB.prepare(
      "SELECT organization_id FROM platform_oauth_flow WHERE id = ?",
    )
      .bind(pending.flowId)
      .first<{ organization_id: string }>();
    expect(persistedWinner?.organization_id).toBe(winner!.organizationId);
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: pending.flowId,
          organizationId,
        })
      ).status,
    ).toBe(409);

    const preAuthority = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    const preAuthorityTrigger = `t06_preselect_${crypto.randomUUID().replaceAll("-", "")}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${preAuthorityTrigger}"
       BEFORE INSERT ON platform_oauth_installation
       WHEN NEW.organization_id = '${organizationId}'
       BEGIN
         UPDATE organization
         SET suspendedAt = CAST(strftime('%s', 'now') AS INTEGER) * 1000
         WHERE id = NEW.organization_id;
       END`,
    ).run();
    try {
      const staleAuthoritySelection = await selectFlow({
        cookies: user.cookies,
        flowId: preAuthority.flowId,
        organizationId,
      });
      expect(staleAuthoritySelection.status).toBe(409);
      expect(
        await testEnv.IDENTITY_DB.prepare(
          "SELECT status, organization_id, installation_id FROM platform_oauth_flow WHERE id = ?",
        )
          .bind(preAuthority.flowId)
          .first(),
      ).toMatchObject({
        status: "pending",
        organization_id: null,
        installation_id: null,
      });
      expect(
        await testEnv.IDENTITY_DB.prepare(
          `SELECT COUNT(*) AS count
           FROM platform_oauth_installation AS installation
           LEFT JOIN platform_oauth_flow AS flow
             ON flow.installation_id = installation.id
           WHERE installation.user_id = ? AND installation.organization_id = ?
             AND flow.id IS NULL`,
        )
          .bind(user.userId, organizationId)
          .first<{ count: number }>(),
      ).toMatchObject({ count: 0 });
    } finally {
      await testEnv.IDENTITY_DB.batch([
        testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${preAuthorityTrigger}"`),
        testEnv.IDENTITY_DB.prepare(
          "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
        ).bind(organizationId),
      ]);
    }

    const expired = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_oauth_flow SET expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 1, expired.flowId)
      .run();
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: expired.flowId,
          organizationId,
        })
      ).status,
    ).toBe(400);

    const denied = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: denied.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const continued = await continueFlow(user.cookies, denied.flowId);
    expect(continued.status).toBe(302);
    const consentLocation = new URL(
      continued.headers.get("location")!,
      "http://localhost",
    );
    const denial = await SELF.fetch(
      "http://localhost/api/auth/oauth2/consent",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: false,
          oauth_query: consentLocation.search.slice(1),
        }),
      },
    );
    expect(denial.status).toBe(200);
    const denialBody = (await denial.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    expect(
      new URL(denialBody.redirect_uri ?? denialBody.url ?? "").searchParams.get(
        "error",
      ),
    ).toBe("access_denied");
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT status FROM platform_oauth_flow WHERE id = ?",
      )
        .bind(denied.flowId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: "rejected" });

    const preActivation = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: preActivation.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const preActivationConsent = await continueFlow(
      user.cookies,
      preActivation.flowId,
    );
    const preActivationConsentUrl = new URL(
      preActivationConsent.headers.get("location")!,
      "http://localhost",
    );
    const preActivationResponse = await SELF.fetch(
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
          oauth_query: preActivationConsentUrl.search.slice(1),
        }),
      },
    );
    expect(preActivationResponse.status).toBe(200);
    const preActivationBody = (await preActivationResponse.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const preActivationCode = new URL(
      preActivationBody.redirect_uri ?? preActivationBody.url ?? "",
    ).searchParams.get("code");
    expect(preActivationCode).toBeTruthy();
    const providerTokenResponse = await createAuth(testEnv, {
      oauthPlatform: true,
      oauthGrantTypes: ["authorization_code"],
      oauthScopes: ["resource:read"],
    }).handler(
      new Request("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          code: preActivationCode!,
          code_verifier: preActivation.verifier,
          resource: service.audience,
        }),
      }),
    );
    expect(providerTokenResponse.status).toBe(200);
    let authorityRead = false;
    const interleavedDatabase = interleavedOAuthAuthorityDatabase(
      testEnv.IDENTITY_DB,
      async () => {
        authorityRead = true;
        const disabled = await testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_service SET disabled = 1 WHERE service_id = ?",
        )
          .bind(service.serviceId)
          .run();
        expect(disabled.meta.changes).toBe(1);
      },
    );
    try {
      const staleActivation = await completeInitialOAuthAccess(
        interleavedDatabase.withSession("first-primary"),
        providerTokenResponse,
      );
      expect(authorityRead).toBe(true);
      expect(staleActivation?.status).toBe(400);
      const staleBinding = await testEnv.IDENTITY_DB.prepare(
        `SELECT installation.active, access.revoked,
                COUNT(credential.id) AS credential_count
         FROM platform_oauth_installation AS installation
         JOIN platform_oauth_flow AS flow ON flow.installation_id = installation.id
         LEFT JOIN oauthAccessToken AS access ON access.referenceId = installation.id
         LEFT JOIN platform_credential AS credential
           ON credential.oauth_installation_id = installation.id
         WHERE flow.id = ?`,
      )
        .bind(preActivation.flowId)
        .first<{
          active: number;
          revoked: number | null;
          credential_count: number;
        }>();
      expect(staleBinding).toMatchObject({
        active: 0,
        revoked: 1,
        credential_count: 0,
      });
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_service SET disabled = 0 WHERE service_id = ?",
      )
        .bind(service.serviceId)
        .run();
    }

    const browserDenied = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: browserDenied.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const browserDenial = await submitBrowserConsent(
      user.cookies,
      browserDenied.flowId,
      false,
    );
    expect(browserDenial.pageText).toContain("resource:read");
    expect(browserDenial.pageHeaders.get("referrer-policy")).toBe(
      "strict-origin",
    );
    expect(browserDenial.pageHeaders.get("content-security-policy")).toContain(
      `form-action 'self' ${new URL(client.redirectUri).origin}`,
    );
    expect(browserDenial.response.status).toBe(303);
    expect(
      new URL(browserDenial.response.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("access_denied");
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT status FROM platform_oauth_flow WHERE id = ?",
      )
        .bind(browserDenied.flowId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: "rejected" });

    const browserApproved = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: browserApproved.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const browserApproval = await submitBrowserConsent(
      user.cookies,
      browserApproved.flowId,
      true,
    );
    expect(browserApproval.response.status).toBe(303);
    const browserCode = new URL(
      browserApproval.response.headers.get("location")!,
    ).searchParams.get("code");
    expect(browserCode).toBeTruthy();
    const browserToken = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          code: browserCode!,
          code_verifier: browserApproved.verifier,
          resource: service.audience,
        }),
      },
    );
    expect(browserToken.status, await browserToken.clone().text()).toBe(200);

    const malformed = await completeInitialOAuthAccess(
      testEnv.IDENTITY_DB,
      Response.json({ access_token: "t06-unbound-success" }),
    );
    expect(malformed?.status).toBe(400);
    const missingToken = await completeInitialOAuthAccess(
      testEnv.IDENTITY_DB,
      Response.json({ refresh_token: "t06-unexpected-refresh" }),
    );
    expect(missingToken?.status).toBe(500);
  });

  it("issues a first-party browser credential for the selected human organization", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t11-browser-service-${suffix}`,
      audience: `https://t11-browser-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn({
      id: 816399,
      login: `t11-browser-${suffix}`,
      email: `t11-browser-${suffix}@example.test`,
    });
    const organizationId = await ownerOrganization(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: `https://t11-browser-client-${suffix}.example.test/callback`,
        capabilities: ["resource:read"],
        authMethod: "client_secret_post",
        purpose: "first_party_browser",
        refreshEnabled: false,
      },
    );
    expect(client.purpose).toBe("first_party_browser");
    expect(client.authMethod).toBe("client_secret_post");
    expect(client.refreshEnabled).toBe(false);
    expect(() =>
      validateTrustedOAuthClientInput(
        {
          serviceId: service.serviceId,
          redirectUri: client.redirectUri,
          capabilities: ["resource:read"],
          authMethod: "none",
          purpose: "first_party_browser",
        },
        testEnv.BETTER_AUTH_SECRET,
      ),
    ).toThrow("first_party_browser_requires_confidential_client");
    expect(() =>
      validateTrustedOAuthClientInput(
        {
          serviceId: service.serviceId,
          redirectUri: client.redirectUri,
          capabilities: ["resource:read"],
          authMethod: "client_secret_post",
          purpose: "first_party_browser",
          refreshEnabled: true,
        },
        testEnv.BETTER_AUTH_SECRET,
      ),
    ).toThrow("first_party_browser_refresh_not_supported");
    const invalidClientId = `t11-invalid-browser-${suffix}`;
    await expect(
      provisionTrustedOAuthClient(
        testEnv.IDENTITY_DB,
        testEnv.BETTER_AUTH_SECRET,
        {
          serviceId: service.serviceId,
          clientId: invalidClientId,
          redirectUri: client.redirectUri,
          capabilities: ["resource:read"],
          authMethod: "none",
          purpose: "first_party_browser",
        },
      ),
    ).rejects.toThrow("first_party_browser_requires_confidential_client");
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM oauthClient WHERE clientId = ?",
      )
        .bind(invalidClientId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    const offlineQuery = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: client.redirectUri,
      scope: "resource:read offline_access",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(opaqueSecret("t11-offline_")),
      code_challenge_method: "S256",
    });
    const offlineRequest = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${offlineQuery}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect([302, 400]).toContain(offlineRequest.status);
    if (offlineRequest.status === 302) {
      expect(
        new URL(offlineRequest.headers.get("location")!).searchParams.get(
          "error",
        ),
      ).toBeTruthy();
    }
    for (const [label, overrides] of [
      [
        "wrong-redirect",
        { redirect_uri: "https://attacker.example.test/callback" },
      ],
      ["wrong-resource", { resource: "https://other-service.0000.test" }],
    ] as const) {
      const redirectUri =
        "redirect_uri" in overrides
          ? overrides.redirect_uri
          : client.redirectUri;
      const resource =
        "resource" in overrides ? overrides.resource : service.audience;
      const invalidRequest = new URLSearchParams({
        client_id: client.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: "resource:read",
        resource,
        state: `${label}-${crypto.randomUUID()}`,
        code_challenge: await challenge(opaqueSecret(`t11-${label}_`)),
        code_challenge_method: "S256",
      });
      const invalid = await SELF.fetch(
        `http://localhost/api/auth/oauth2/authorize?${invalidRequest}`,
        { headers: { cookie: user.cookies }, redirect: "manual" },
      );
      expect([302, 400]).toContain(invalid.status);
      if (invalid.status === 302) {
        expect(
          new URL(invalid.headers.get("location")!).searchParams.get("error"),
        ).toBeTruthy();
      }
    }

    const preview = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    const selected = await selectFlow({
      cookies: user.cookies,
      flowId: preview.flowId,
      organizationId,
    });
    expect(selected.status).toBe(303);
    const continued = await continueFlow(user.cookies, preview.flowId);
    expect(continued.status).toBe(302);
    const consentLocation = new URL(
      continued.headers.get("location")!,
      "http://localhost",
    );
    const consentPage = await SELF.fetch(consentLocation, {
      headers: { cookie: user.cookies },
    });
    const consentText = await consentPage.text();
    expect(consentText).toContain("uses your signed-in human account");
    expect(consentText).toContain("organization you selected");
    expect(consentText).not.toContain("personal-harness agent");
    const deniedPreview = await SELF.fetch(
      "http://localhost/api/auth/oauth2/consent",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: false,
          oauth_query: consentLocation.search.slice(1),
        }),
      },
    );
    expect(deniedPreview.status).toBe(200);

    const issued = await completeFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId,
      client,
      audience: service.audience,
      clientSecret: client.clientSecret!,
    });
    const invalidBinding = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: invalidBinding.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const invalidBindingContinue = await continueFlow(
      user.cookies,
      invalidBinding.flowId,
    );
    const invalidBindingConsent = new URL(
      invalidBindingContinue.headers.get("location")!,
      "http://localhost",
    );
    const invalidBindingApproval = await SELF.fetch(
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
          oauth_query: invalidBindingConsent.search.slice(1),
        }),
      },
    );
    expect(invalidBindingApproval.status).toBe(200);
    const invalidBindingBody = (await invalidBindingApproval.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const invalidBindingCode = new URL(
      invalidBindingBody.redirect_uri ?? invalidBindingBody.url ?? "",
      "http://localhost",
    ).searchParams.get("code");
    expect(invalidBindingCode).toBeTruthy();
    const wrongClient = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: `${client.clientId}-wrong`,
          client_secret: client.clientSecret!,
          redirect_uri: client.redirectUri,
          code: invalidBindingCode!,
          code_verifier: invalidBinding.verifier,
          resource: service.audience,
        }),
      },
    );
    expect(wrongClient.status).toBe(400);
    const wrongPkce = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          redirect_uri: client.redirectUri,
          code: invalidBindingCode!,
          code_verifier: opaqueSecret("t11-wrong-pkce_"),
          resource: service.audience,
        }),
      },
    );
    expect(wrongPkce.status).toBe(400);

    const installation = await testEnv.IDENTITY_DB.prepare(
      `SELECT i.id, i.purpose, i.user_id, i.membership_id, i.organization_id,
              c.id AS credential_id, c.kind, c.subject_id, c.grant_id
       FROM platform_oauth_installation AS i
       JOIN platform_credential AS c ON c.oauth_installation_id = i.id
       WHERE i.client_id = ? AND i.organization_id = ? AND i.active = 1
       ORDER BY i.created_at DESC LIMIT 1`,
    )
      .bind(client.clientId, organizationId)
      .first<{
        id: string;
        purpose: string;
        user_id: string;
        membership_id: string;
        organization_id: string;
        credential_id: string;
        kind: string;
        subject_id: string;
        grant_id: string | null;
      }>();
    expect(installation).toMatchObject({
      purpose: "first_party_browser",
      user_id: user.userId,
      organization_id: organizationId,
      kind: "human",
      subject_id: user.userId,
      grant_id: null,
    });
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_oauth_client SET purpose = 'personal_harness' WHERE client_id = ?",
      )
        .bind(client.clientId)
        .run(),
    ).rejects.toThrow(/purpose is immutable/);
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_oauth_flow SET purpose = 'personal_harness' WHERE installation_id = ?",
      )
        .bind(installation?.id)
        .run(),
    ).rejects.toThrow(/purpose is immutable/);
    await expect(
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_oauth_installation SET purpose = 'personal_harness' WHERE id = ?",
      )
        .bind(installation?.id)
        .run(),
    ).rejects.toThrow(/purpose is immutable/);
    await expect(
      testEnv.IDENTITY_DB.prepare(
        `INSERT INTO platform_oauth_installation
         (id, client_id, user_id, membership_id, organization_id, service_id,
          audience, capabilities, subject_id, grant_id, purpose, active,
          revoked_at, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'personal_harness', 0, NULL, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          client.clientId,
          user.userId,
          installation!.membership_id,
          organizationId,
          service.serviceId,
          service.audience,
          JSON.stringify(["resource:read"]),
          `t11-spoof-subject-${suffix}`,
          `t11-spoof-grant-${suffix}`,
          Date.now(),
          Date.now() + 60_000,
        )
        .run(),
    ).rejects.toThrow(/purpose mismatch/);
    const authorityRace = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    const authorityRaceTrigger = `t11_authority_race_${crypto.randomUUID().replaceAll("-", "")}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${authorityRaceTrigger}"
       BEFORE INSERT ON platform_oauth_installation
       WHEN NEW.client_id = '${client.clientId}'
       BEGIN
         UPDATE platform_service SET disabled = 1 WHERE service_id = '${service.serviceId}';
       END`,
    ).run();
    try {
      const staleSelection = await selectFlow({
        cookies: user.cookies,
        flowId: authorityRace.flowId,
        organizationId,
      });
      expect(staleSelection.status).toBe(409);
    } finally {
      await testEnv.IDENTITY_DB.batch([
        testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${authorityRaceTrigger}"`),
        testEnv.IDENTITY_DB.prepare(
          "UPDATE platform_service SET disabled = 0 WHERE service_id = ?",
        ).bind(service.serviceId),
      ]);
    }

    const sharedClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: service.audience,
      serviceVerifier: service.verifier,
      fetch: SELF.fetch,
    });
    const authenticated = await sharedClient.authenticate(issued.accessToken);
    expect(authenticated.status, JSON.stringify(authenticated)).toBe(
      "authenticated",
    );
    if (authenticated.status === "authenticated") {
      expect(authenticated.principal).toMatchObject({
        kind: "human",
        subjectId: user.userId,
        membershipId: installation?.membership_id,
        organizationId,
        audience: service.audience,
      });
      expect("grantId" in authenticated.principal).toBe(false);
    }
    const otherService = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t11-other-audience-${suffix}`,
      audience: `https://t11-other-audience-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const otherAudienceClient = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: otherService.audience,
      serviceVerifier: otherService.verifier,
      fetch: SELF.fetch,
    });
    expect(
      await otherAudienceClient.authenticate(issued.accessToken),
    ).toMatchObject({
      status: "invalid_credential",
    });

    const refreshRejected = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          refresh_token: "t11-first-party-refresh-not-issued",
          resource: service.audience,
        }),
      },
    );
    expect(refreshRejected.status).toBe(400);
    expect(
      (await refreshRejected.json()) as { access_token?: string },
    ).not.toHaveProperty("access_token");

    const manualResponse = await SELF.fetch(
      "http://localhost/api/credentials",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId,
          serviceId: service.serviceId,
          capabilities: ["resource:read"],
        }),
      },
    );
    expect(manualResponse.status).toBe(201);
    const manual = (await manualResponse.json()) as {
      credential: string;
      credentialId: string;
    };
    const manualAuthentication = await sharedClient.authenticate(
      manual.credential,
    );
    expect(manualAuthentication.status).toBe("authenticated");
    const listedCredentials = await SELF.fetch(
      `http://localhost/api/credentials?organizationId=${encodeURIComponent(organizationId)}`,
      { headers: { cookie: user.cookies } },
    );
    expect(listedCredentials.status).toBe(200);
    const listed = (await listedCredentials.json()) as {
      credentials: Array<{ id: string }>;
    };
    expect(listed.credentials).toContainEqual(
      expect.objectContaining({ id: manual.credentialId }),
    );
    expect(listed.credentials).not.toContainEqual(
      expect.objectContaining({ id: installation?.credential_id }),
    );
    const oauthCredentialId = installation!.credential_id;
    const rotate = await SELF.fetch("http://localhost/api/credentials/rotate", {
      method: "POST",
      headers: {
        cookie: user.cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ organizationId, credentialId: oauthCredentialId }),
    });
    expect(rotate.status).toBe(404);
    const revoke = await SELF.fetch("http://localhost/api/credentials/revoke", {
      method: "POST",
      headers: {
        cookie: user.cookies,
        origin: testEnv.PLATFORM_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({ organizationId, credentialId: oauthCredentialId }),
    });
    expect(revoke.status).toBe(404);
    expect((await sharedClient.authenticate(issued.accessToken)).status).toBe(
      "authenticated",
    );

    const activeIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: issued.accessToken,
        }),
      },
    );
    expect(activeIntrospection.status).toBe(200);
    expect(
      (await activeIntrospection.json()) as { active?: boolean },
    ).toMatchObject({
      active: true,
    });

    const secondOrganizationId = crypto.randomUUID();
    const secondMembershipId = crypto.randomUUID();
    await testEnv.IDENTITY_DB.batch([
      testEnv.IDENTITY_DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(
        secondOrganizationId,
        `T11 second organization ${suffix}`,
        `t11-second-${suffix}`,
        Date.now(),
      ),
      testEnv.IDENTITY_DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind(secondMembershipId, secondOrganizationId, user.userId, Date.now()),
    ]);
    const secondIssued = await completeFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId: secondOrganizationId,
      client,
      audience: service.audience,
      clientSecret: client.clientSecret!,
    });
    const secondAuthentication = await sharedClient.authenticate(
      secondIssued.accessToken,
    );
    expect(secondAuthentication.status).toBe("authenticated");
    if (secondAuthentication.status === "authenticated") {
      expect(secondAuthentication.principal).toMatchObject({
        kind: "human",
        subjectId: user.userId,
        organizationId: secondOrganizationId,
        membershipId: secondMembershipId,
      });
    }

    const replacementMembershipId = crypto.randomUUID();
    await testEnv.IDENTITY_DB.batch([
      testEnv.IDENTITY_DB.prepare("DELETE FROM member WHERE id = ?").bind(
        installation!.membership_id,
      ),
      testEnv.IDENTITY_DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind(replacementMembershipId, organizationId, user.userId, Date.now()),
    ]);
    expect((await sharedClient.authenticate(issued.accessToken)).status).toBe(
      "invalid_credential",
    );
    expect(
      (await sharedClient.authenticate(secondIssued.accessToken)).status,
    ).toBe("authenticated");
    const staleIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret!,
          token: issued.accessToken,
        }),
      },
    );
    expect(staleIntrospection.status).toBe(200);
    expect(
      (await staleIntrospection.json()) as { active?: boolean },
    ).toMatchObject({
      active: false,
    });

    const revokeInstallation = await SELF.fetch(
      "http://localhost/api/account/oauth-installations/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: installation?.id,
          organizationId,
        }),
      },
    );
    expect(revokeInstallation.status).toBe(200);
    expect((await sharedClient.authenticate(issued.accessToken)).status).toBe(
      "invalid_credential",
    );
    expect(
      (await sharedClient.authenticate(secondIssued.accessToken)).status,
    ).toBe("authenticated");
  });

  it("accepts a confidential client secret stored with the pinned provider crypto", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-confidential-service",
      audience: "https://t06-confidential.0000.test",
      capabilities: ["resource:read"],
    });
    const operator = await signIn({
      id: 816346,
      login: "t06-confidential-operator",
      email: "operator-confidential-t06@example.test",
    });
    const user = await signIn({
      id: 816347,
      login: "t06-confidential-user",
      email: "user-confidential-t06@example.test",
    });
    const organizationId = await ownerOrganization(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-confidential-client.example.test/callback",
        capabilities: ["resource:read"],
        authMethod: "client_secret_post",
        ownerUserId: operator.userId,
      },
    );
    expect(client.clientSecret).toBeTruthy();
    const result = await completeFlow({
      cookies: user.cookies,
      userId: user.userId,
      organizationId,
      client,
      audience: service.audience,
      clientSecret: client.clientSecret ?? undefined,
    });
    expect(result.accessToken).toBeTruthy();
    const activeIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: result.accessToken,
          client_id: client.clientId,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(activeIntrospection.status).toBe(200);
    expect(await activeIntrospection.json()).toMatchObject({ active: true });
    await testEnv.IDENTITY_DB.batch([
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_oauth_client SET active = 0 WHERE client_id = ?",
      ).bind(client.clientId),
      testEnv.IDENTITY_DB.prepare(
        "UPDATE platform_service SET disabled = 1 WHERE service_id = ?",
      ).bind(service.serviceId),
    ]);
    const disabledJsonIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: result.accessToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }),
      },
    );
    expect(disabledJsonIntrospection.status).toBe(415);
    const disabledJsonToken = await SELF.fetch(
      "http://localhost/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: "not-issued",
        }),
      },
    );
    expect(disabledJsonToken.status).toBe(400);
    expect(await disabledJsonToken.json()).toMatchObject({
      error: "unsupported_grant_type",
    });
    const disabledIntrospection = await SELF.fetch(
      "http://localhost/api/auth/oauth2/introspect",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: result.accessToken,
          client_id: client.clientId,
          client_secret: client.clientSecret!,
        }),
      },
    );
    expect(disabledIntrospection.status).toBe(200);
    expect(await disabledIntrospection.json()).toMatchObject({ active: false });
    const encrypted = await testEnv.IDENTITY_DB.prepare(
      "SELECT clientSecret FROM oauthClient WHERE clientId = ?",
    )
      .bind(client.clientId)
      .first<{ clientSecret: string }>();
    expect(encrypted?.clientSecret).toBeTruthy();
    expect(encrypted?.clientSecret).not.toBe(client.clientSecret);
  });

  it("fails closed when authority changes at the activation barrier", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-activation-race-service",
      audience: "https://t06-activation-race.0000.test",
      capabilities: ["resource:read"],
    });
    const operator = await signIn({
      id: 816353,
      login: "t06-race-operator",
      email: "operator-race-t06@example.test",
    });
    const user = await signIn({
      id: 816354,
      login: "t06-race-user",
      email: "user-race-t06@example.test",
    });
    const organizationId = await ownerOrganization(user.cookies);
    const client = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-race-client.example.test/callback",
        capabilities: ["resource:read"],
        authMethod: "none",
        ownerUserId: operator.userId,
      },
    );
    const flow = await beginSelection({
      cookies: user.cookies,
      userId: user.userId,
      client,
      audience: service.audience,
    });
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: flow.flowId,
          organizationId,
        })
      ).status,
    ).toBe(303);
    const continued = await continueFlow(user.cookies, flow.flowId);
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
    const code = new URL(
      consentBody.redirect_uri ?? consentBody.url ?? "",
      "http://localhost",
    ).searchParams.get("code");
    expect(code).toBeTruthy();
    const triggerName = `t06_suspend_${crypto.randomUUID().replaceAll("-", "")}`;
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER "${triggerName}"
       BEFORE UPDATE OF active ON platform_oauth_installation
       WHEN NEW.active = 1
       BEGIN
         UPDATE organization
         SET suspendedAt = CAST(strftime('%s', 'now') AS INTEGER) * 1000
         WHERE id = NEW.organization_id;
       END`,
    ).run();
    try {
      const token = await SELF.fetch("http://localhost/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          redirect_uri: client.redirectUri,
          code: code!,
          code_verifier: flow.verifier,
          resource: service.audience,
        }),
      });
      expect(token.status).toBe(500);
      const installation = await testEnv.IDENTITY_DB.prepare(
        `SELECT i.active, i.revoked_at, f.status,
                c.revoked_at AS credential_revoked_at, a.revoked
         FROM platform_oauth_installation AS i
         JOIN platform_oauth_flow AS f ON f.installation_id = i.id
         LEFT JOIN platform_credential AS c ON c.oauth_installation_id = i.id
         LEFT JOIN oauthAccessToken AS a ON a.id = c.oauth_provider_row_id
         WHERE i.id = f.installation_id AND f.id = ?`,
      )
        .bind(flow.flowId)
        .first<{
          active: number;
          revoked_at: number | null;
          status: string;
          credential_revoked_at: number | null;
          revoked: number | null;
        }>();
      expect(installation).toMatchObject({
        active: 0,
        status: "rejected",
        revoked: 1,
      });
      expect(installation?.revoked_at).toBeTruthy();
      expect(installation?.credential_revoked_at).toBeTruthy();
    } finally {
      await testEnv.IDENTITY_DB.batch([
        testEnv.IDENTITY_DB.prepare(`DROP TRIGGER "${triggerName}"`),
        testEnv.IDENTITY_DB.prepare(
          "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
        ).bind(organizationId),
      ]);
    }
  });

  it("keeps the service resource catalog above each client ceiling", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-resource-catalog-service",
      audience: "https://t06-resource-catalog.0000.test",
      capabilities: ["resource:read", "resource:write"],
    });
    const operator = await signIn({
      id: 816351,
      login: "t06-resource-operator",
      email: "operator-resource-t06@example.test",
    });
    const user = await signIn({
      id: 816352,
      login: "t06-resource-user",
      email: "user-resource-t06@example.test",
    });
    const clientWithWrite = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-resource-a.example.test/callback",
        capabilities: ["resource:read", "resource:write"],
        authMethod: "none",
        ownerUserId: operator.userId,
      },
    );
    const readOnlyClient = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-resource-b.example.test/callback",
        capabilities: ["resource:read"],
        authMethod: "none",
        ownerUserId: operator.userId,
      },
    );
    const resource = await testEnv.IDENTITY_DB.prepare(
      "SELECT allowedScopes FROM oauthResource WHERE identifier = ?",
    )
      .bind(service.audience)
      .first<{ allowedScopes: string }>();
    expect(JSON.parse(resource?.allowedScopes ?? "[]")).toEqual([
      "resource:read",
      "resource:write",
    ]);
    const organizationId = await ownerOrganization(user.cookies);
    const writeVerifier = opaqueSecret("t06-write-verifier_");
    const writeQuery = new URLSearchParams({
      client_id: clientWithWrite.clientId,
      response_type: "code",
      redirect_uri: clientWithWrite.redirectUri,
      scope: "resource:write",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(writeVerifier),
      code_challenge_method: "S256",
    });
    const writeAuthorize = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${writeQuery}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect(writeAuthorize.status).toBe(302);
    const writeSelection = new URL(
      writeAuthorize.headers.get("location")!,
      "http://localhost",
    );
    const writePage = await SELF.fetch(writeSelection, {
      headers: { cookie: user.cookies },
    });
    expect(await writePage.text()).toContain("resource:write");
    const readVerifier = opaqueSecret("t06-read-verifier_");
    const readQuery = new URLSearchParams({
      client_id: clientWithWrite.clientId,
      response_type: "code",
      redirect_uri: clientWithWrite.redirectUri,
      scope: "resource:read",
      resource: service.audience,
      state: crypto.randomUUID(),
      code_challenge: await challenge(readVerifier),
      code_challenge_method: "S256",
    });
    const readAuthorize = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${readQuery}`,
      { headers: { cookie: user.cookies }, redirect: "manual" },
    );
    expect(readAuthorize.status).toBe(302);
    const readSelection = new URL(
      readAuthorize.headers.get("location")!,
      "http://localhost",
    );
    const readPage = await SELF.fetch(readSelection, {
      headers: { cookie: user.cookies },
    });
    const readPageText = await readPage.text();
    expect(readPageText).toContain("resource:read");
    expect(readPageText).not.toContain("resource:write");
    expect(readOnlyClient.clientId).not.toBe(clientWithWrite.clientId);
    expect(organizationId).toBeTruthy();

    const staleRegistration = await prepareTrustedOAuthClientRegistration(
      {
        serviceId: service.serviceId,
        redirectUri: "https://t06-resource-stale.example.test/callback",
        capabilities: ["resource:write"],
        authMethod: "none",
        ownerUserId: operator.userId,
        clientId: "t06-stale-catalog-client",
      },
      {
        serviceId: service.serviceId,
        audience: service.audience,
        catalog: ["resource:read", "resource:write"],
      },
      testEnv.BETTER_AUTH_SECRET,
    );
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_service SET allowed_capabilities = ? WHERE service_id = ?",
    )
      .bind(JSON.stringify(["resource:read"]), service.serviceId)
      .run();
    const staleWrites = await testEnv.IDENTITY_DB.batch(
      trustedOAuthClientStatements(staleRegistration).map((statement) =>
        testEnv.IDENTITY_DB.prepare(statement.sql).bind(...statement.values),
      ),
    );
    expect(staleWrites.map((result) => result.meta.changes)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT COUNT(*) AS count FROM platform_oauth_client WHERE client_id = ?",
      )
        .bind(staleRegistration.clientId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });
});
