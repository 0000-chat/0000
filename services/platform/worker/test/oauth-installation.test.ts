import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeInitialOAuthAccess,
  provisionTrustedOAuthClient,
} from "../../src/oauth-installation";
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
): Promise<{ response: Response; location: URL; pageText: string }> {
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
  return { response, location, pageText };
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
    await testEnv.IDENTITY_DB.prepare("DELETE FROM member WHERE id = ?")
      .bind(installation!.membership_id)
      .run();
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
    expect(
      (
        await Promise.all([
          selectFlow({
            cookies: user.cookies,
            flowId: pending.flowId,
            organizationId,
          }),
          selectFlow({
            cookies: user.cookies,
            flowId: pending.flowId,
            organizationId: secondOrganizationId,
          }),
        ])
      )
        .map((response) => response.status)
        .sort(),
    ).toEqual([303, 409]);
    expect(
      (
        await selectFlow({
          cookies: user.cookies,
          flowId: pending.flowId,
          organizationId,
        })
      ).status,
    ).toBe(409);

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
  });
});
