import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionTrustedOAuthClient } from "../../src/oauth-installation";
import { registerService } from "../../src/service-registration";
import { opaqueSecret } from "../../src/platform-state";
import { createPlatformClient } from "@0000/platform-client";

const testEnv = env as Cloudflare.Env;
let currentProfile = {
  id: 812345,
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

async function completeFlow(input: {
  cookies: string;
  userId: string;
  organizationId: string;
  client: Awaited<ReturnType<typeof provisionTrustedOAuthClient>>;
  audience: string;
  clientSecret?: string;
}): Promise<{ accessToken: string; verifier: string }> {
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
  return { accessToken: tokenBody.access_token, verifier };
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
      id: 812344,
      login: "t06-operator",
      email: "operator-t06@example.test",
    });
    const user = await signIn({
      id: 812345,
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
        id: 812345,
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
    expect(authenticated.status).toBe("authenticated");
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
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), organizationId)
      .run();
    expect(
      (await sharedClient.authenticate(tokenBody.access_token)).status,
    ).toBe("invalid_credential");
  });

  it("accepts a confidential client secret stored with the pinned provider crypto", async () => {
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: "t06-confidential-service",
      audience: "https://t06-confidential.0000.test",
      capabilities: ["resource:read"],
    });
    const operator = await signIn({
      id: 812346,
      login: "t06-confidential-operator",
      email: "operator-confidential-t06@example.test",
    });
    const user = await signIn({
      id: 812347,
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
    const encrypted = await testEnv.IDENTITY_DB.prepare(
      "SELECT clientSecret FROM oauthClient WHERE clientId = ?",
    )
      .bind(client.clientId)
      .first<{ clientSecret: string }>();
    expect(encrypted?.clientSecret).toBeTruthy();
    expect(encrypted?.clientSecret).not.toBe(client.clientSecret);
  });
});
