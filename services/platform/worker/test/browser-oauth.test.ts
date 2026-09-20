import {
  createPlatformBrowserClient,
  type BrowserOAuthTransaction,
} from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionTrustedOAuthClient } from "../../src/oauth-installation";
import { registerService } from "../../src/service-registration";
import {
  handleBrowserFixtureRequest,
  D1BrowserOAuthTransactionStore,
} from "./fixtures/browser-oauth";

const testEnv = env as Cloudflare.Env;
const provider = {
  id: 817001,
  login: "t11-browser-fixture",
  email: "t11-browser-fixture@example.test",
};

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const values = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join("; ");
}

function cookiePair(header: string): string {
  return header.split(";", 1)[0]!;
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
  const startBody = (await start.json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await SELF.fetch(
    `http://localhost/api/auth/callback/github?code=fixture-provider-code&state=${encodeURIComponent(state!)}`,
    { headers: { cookie: cookiesFrom(start) }, redirect: "manual" },
  );
  expect(callback.status).toBe(302);
  const cookies = cookiesFrom(start, callback);
  const session = await SELF.fetch("http://localhost/api/auth/get-session", {
    headers: { cookie: cookies },
  });
  const body = (await session.json()) as { user: { id: string } };
  return { cookies, userId: body.user.id };
}

async function organizationId(cookies: string): Promise<string> {
  const response = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie: cookies },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { organizationId: string }).organizationId;
}

async function completeWorkerAuthorization(input: {
  authorizationUrl: string;
  cookies: string;
  userId: string;
  organizationId: string;
}): Promise<string> {
  const authorize = await SELF.fetch(input.authorizationUrl, {
    headers: { cookie: input.cookies },
    redirect: "manual",
  });
  expect(authorize.status).toBe(302);
  const selection = new URL(
    authorize.headers.get("location")!,
    "http://localhost",
  );
  await SELF.fetch(selection, { headers: { cookie: input.cookies } });
  const flow = await testEnv.IDENTITY_DB.prepare(
    `SELECT id FROM platform_oauth_flow
     WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
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
    new URL(selected.headers.get("location")!, "http://localhost"),
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
  const body = (await consent.json()) as {
    redirect_uri?: string;
    url?: string;
  };
  const callback = body.redirect_uri ?? body.url;
  expect(callback).toBeTruthy();
  return callback!;
}

function browserClient(
  store: D1BrowserOAuthTransactionStore,
  service: { audience: string; verifier: string },
  client: { clientId: string; clientSecret: string | null },
  now: () => number,
) {
  return createPlatformBrowserClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceVerifier: service.verifier,
    clientId: client.clientId,
    clientSecret: client.clientSecret!,
    redirectUri: "https://t11-browser-fixture.example.test/oauth/callback",
    resource: service.audience,
    scopes: ["resource:read"],
    returnOrigin: "https://t11-browser-fixture.example.test",
    transactionStore: store,
    fetch: SELF.fetch,
    now,
  });
}

describe("T11 shared browser OAuth consumer fixture", () => {
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
            access_token: "t11-browser-provider-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: provider.id,
            login: provider.login,
            name: "T11 Browser Fixture",
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            { email: provider.email, primary: true, verified: true },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("runs the shared helper through the real Worker/D1 flow and serves a fixture with its HttpOnly cookie", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const service = await registerService(testEnv.IDENTITY_DB, {
      serviceId: `t11-browser-consumer-${suffix}`,
      audience: `https://t11-browser-consumer-${suffix}.0000.test`,
      capabilities: ["resource:read"],
    });
    const user = await signIn();
    const selectedOrganization = await organizationId(user.cookies);
    const clientRegistration = await provisionTrustedOAuthClient(
      testEnv.IDENTITY_DB,
      testEnv.BETTER_AUTH_SECRET,
      {
        serviceId: service.serviceId,
        redirectUri: "https://t11-browser-fixture.example.test/oauth/callback",
        capabilities: ["resource:read"],
        authMethod: "client_secret_post",
        purpose: "first_party_browser",
      },
    );
    const store = new D1BrowserOAuthTransactionStore(testEnv.IDENTITY_DB);
    const client = browserClient(
      store,
      service,
      clientRegistration,
      Date.now.bind(Date),
    );
    const started = await client.start({ returnTo: "/dashboard" });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const callbackUrl = await completeWorkerAuthorization({
      authorizationUrl: started.authorizationUrl,
      cookies: user.cookies,
      userId: user.userId,
      organizationId: selectedOrganization,
    });

    const wrongBrowser = await client.callback(
      new Request(callbackUrl, {
        headers: { cookie: "__Host-0000-oauth-binding=wrong-browser" },
      }),
    );
    expect(wrongBrowser).toMatchObject({
      status: "invalid_login",
      reason: "invalid_state",
    });
    const callbacks = await Promise.all([
      client.callback(
        new Request(callbackUrl, {
          headers: { cookie: cookiePair(started.setCookie) },
        }),
      ),
      client.callback(
        new Request(callbackUrl, {
          headers: { cookie: cookiePair(started.setCookie) },
        }),
      ),
    ]);
    const winner = callbacks.find(
      (result) => result.status === "authenticated",
    );
    expect(winner).toBeTruthy();
    expect(
      callbacks.filter((result) => result.status === "invalid_login"),
    ).toHaveLength(1);
    if (!winner || winner.status !== "authenticated") return;
    expect(winner.returnTo).toBe("/dashboard");
    expect(winner).not.toHaveProperty("credential");

    const resourceId = `t11-browser-resource-${suffix}`;
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience)
       VALUES (?, 'organization', ?, ?, ?)`,
    )
      .bind(resourceId, selectedOrganization, Date.now(), service.audience)
      .run();
    const resourceResponse = await handleBrowserFixtureRequest(
      new Request(`https://fixture.test/resources/${resourceId}`, {
        headers: { cookie: cookiePair(winner.setCookie) },
      }),
      {
        database: testEnv.IDENTITY_DB,
        platformBaseUrl: testEnv.PLATFORM_BASE_URL,
        authority: testEnv.PLATFORM_AUTHORITY_ID,
        audience: service.audience,
        serviceVerifier: service.verifier,
        guestGrantIssuer: "unused-in-human-fixture",
        fetch: SELF.fetch,
        serviceId: service.serviceId,
      },
    );
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toEqual({
      id: resourceId,
      ownerKind: "organization",
    });

    const replay = await client.callback(
      new Request(callbackUrl, {
        headers: { cookie: cookiePair(started.setCookie) },
      }),
    );
    expect(replay).toMatchObject({
      status: "invalid_login",
      reason: "invalid_state",
    });
    const installation = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM platform_oauth_installation WHERE client_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(clientRegistration.clientId)
      .first<{ id: string }>();
    expect(installation).toBeTruthy();
    const revoked = await SELF.fetch(
      "http://localhost/api/account/oauth-installations/revoke",
      {
        method: "POST",
        headers: {
          cookie: user.cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: installation!.id,
          organizationId: selectedOrganization,
        }),
      },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await handleBrowserFixtureRequest(
      new Request(`https://fixture.test/resources/${resourceId}`, {
        headers: { cookie: cookiePair(winner.setCookie) },
      }),
      {
        database: testEnv.IDENTITY_DB,
        platformBaseUrl: testEnv.PLATFORM_BASE_URL,
        authority: testEnv.PLATFORM_AUTHORITY_ID,
        audience: service.audience,
        serviceVerifier: service.verifier,
        guestGrantIssuer: "unused-in-human-fixture",
        fetch: SELF.fetch,
        serviceId: service.serviceId,
      },
    );
    expect(afterRevoke.status).toBe(401);
  });

  it("expires D1 records and removes them through bounded cleanup", async () => {
    const store = new D1BrowserOAuthTransactionStore(testEnv.IDENTITY_DB);
    const now = Date.now();
    const row = (index: number): BrowserOAuthTransaction => ({
      stateHash: `expired-state-${index}`,
      browserBindingHash: `expired-binding-${index}`,
      codeVerifier: `verifier-${index}`,
      codeChallenge: `challenge-${index}`,
      clientId: "fixture-client",
      redirectUri: "https://t11-browser-fixture.example.test/oauth/callback",
      resource: "https://service.0000.test",
      scopes: ["resource:read"],
      returnTo: "/",
      expiresAt: now - index - 1,
    });
    for (let index = 0; index < 5; index += 1) await store.put(row(index));
    expect(
      await store.consume({
        stateHash: "expired-state-0",
        browserBindingHash: "expired-binding-0",
        now,
      }),
    ).toBeNull();
    expect(await store.cleanup({ now, limit: 2 })).toBe(2);
    expect(await store.cleanup({ now, limit: 10 })).toBe(3);
  });
});
