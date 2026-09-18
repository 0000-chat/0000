import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opaqueSecret } from "../../src/platform-state";

const testEnv = env as Cloudflare.Env;
const clientId = "t01-public-client";
const redirectUri = "https://client.example.test/callback";
const resource = "https://fixture.0000.test";

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

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

async function formPost(
  path: string,
  values: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`http://localhost/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

describe("Better Auth OAuth Provider D1 lifecycle", () => {
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

  it("enforces PKCE and exact resource/client bindings, then rotates and rejects refresh-token reuse on D1", async () => {
    const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: testEnv.PLATFORM_BASE_URL,
      },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "http://localhost/after-login",
      }),
    });
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

    const session = await SELF.fetch("http://localhost/api/auth/get-session", {
      headers: { cookie: cookies },
    });
    const sessionBody = (await session.json()) as { user: { id: string } };
    const now = Date.now();
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO oauthClient
       (id, clientId, disabled, skipConsent, scopes, clientCredentialsScopes, userId,
        createdAt, updatedAt, name, redirectUris, grantTypes, responseTypes,
        tokenEndpointAuthMethod, applicationType, requirePKCE)
       VALUES (?, ?, 0, 0, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 'none', 'web', 1)`,
    )
      .bind(
        crypto.randomUUID(),
        clientId,
        JSON.stringify(["resource:read", "offline_access"]),
        sessionBody.user.id,
        now,
        now,
        "T01 probe public client",
        JSON.stringify([redirectUri]),
        JSON.stringify(["authorization_code", "refresh_token"]),
        JSON.stringify(["code"]),
      )
      .run();
    await testEnv.IDENTITY_DB.prepare(
      "INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), clientId, resource, now)
      .run();

    const missingPkceQuery = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "resource:read offline_access",
      state: "missing-pkce-state",
      resource,
    });
    const missingPkce = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${missingPkceQuery}`,
      {
        headers: { cookie: cookies },
        redirect: "manual",
      },
    );
    const missingPkceUrl = new URL(
      missingPkce.headers.get("location") ?? "http://invalid.test",
    );
    expect(missingPkce.status).toBe(302);
    expect(missingPkceUrl.searchParams.get("error")).toBe("invalid_request");

    const verifier = opaqueSecret("verifier_");
    const challenge = await pkceChallenge(verifier);
    const validAuthorizeFields = {
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "resource:read offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    for (const [label, overrides] of [
      [
        "unregistered redirect",
        { redirect_uri: "https://attacker.example/callback" },
      ],
      ["unregistered resource", { resource: "https://unregistered.0000.test" }],
      ["unregistered client", { client_id: "t01-unregistered-client" }],
    ] as const) {
      const rejectedQuery = new URLSearchParams({
        ...validAuthorizeFields,
        ...overrides,
        state: label,
      });
      const rejected = await SELF.fetch(
        `http://localhost/api/auth/oauth2/authorize?${rejectedQuery}`,
        {
          headers: { cookie: cookies },
          redirect: "manual",
        },
      );
      expect(rejected.status, label).toBe(302);
      const errorLocation = new URL(
        rejected.headers.get("location") ?? "http://invalid.test",
      );
      expect(errorLocation.searchParams.get("error"), label).toBeTruthy();
    }

    const authorizeQuery = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "resource:read offline_access",
      state: "client-state-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    });
    const authorize = await SELF.fetch(
      `http://localhost/api/auth/oauth2/authorize?${authorizeQuery}`,
      { headers: { cookie: cookies }, redirect: "manual" },
    );
    expect(authorize.status).toBe(302);
    const authorizationLocation = authorize.headers.get("location");
    expect(authorizationLocation, await authorize.clone().text()).toBeTruthy();
    const consentLocation = new URL(authorizationLocation!, "http://localhost");
    expect(consentLocation.pathname).toBe("/consent");
    const oauthQuery = consentLocation.search.slice(1);
    expect(oauthQuery).toBeTruthy();

    const consent = await SELF.fetch(
      "http://localhost/api/auth/oauth2/consent",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
      },
    );
    expect(consent.status).toBe(200);
    const consentBody = (await consent.json()) as {
      redirect_uri?: string;
      redirect?: boolean;
      url?: string;
    };
    const returnedRedirect = consentBody.redirect_uri ?? consentBody.url;
    expect(returnedRedirect, JSON.stringify(consentBody)).toBeTruthy();
    const callbackUrl = new URL(returnedRedirect!);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
    expect(callbackUrl.searchParams.get("state")).toBe("client-state-1");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await formPost("/oauth2/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: code!,
      code_verifier: verifier,
      resource,
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(tokenBody.token_type.toLowerCase()).toBe("bearer");
    expect(tokenBody.scope.split(" ")).toEqual(
      expect.arrayContaining(["resource:read", "offline_access"]),
    );
    expect(tokenBody.access_token.split(".")).toHaveLength(1);
    const storedAccessTokens = await testEnv.IDENTITY_DB.prepare(
      "SELECT token FROM oauthAccessToken WHERE clientId = ?",
    )
      .bind(clientId)
      .all<{ token: string }>();
    expect(storedAccessTokens.results).not.toHaveLength(0);
    expect(
      storedAccessTokens.results.every(
        (row) => row.token !== tokenBody.access_token,
      ),
    ).toBe(true);

    const firstRefresh = await formPost("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokenBody.refresh_token,
      resource,
    });
    expect(firstRefresh.status).toBe(200);
    const rotated = (await firstRefresh.json()) as Record<string, unknown>;
    const rotationRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, token, revoked, rotatedAt, scopes FROM oauthRefreshToken WHERE clientId = ?",
    )
      .bind(clientId)
      .all<{
        id: string;
        token: string;
        revoked: number | null;
        rotatedAt: number | null;
        scopes: string;
      }>();
    expect(
      rotated.refresh_token,
      JSON.stringify({
        responseKeys: Object.keys(rotated),
        scope: rotated.scope,
        refreshRows: rotationRows.results.map(
          ({ id, revoked, rotatedAt, scopes }) => ({
            id,
            revoked,
            rotatedAt,
            scopes,
          }),
        ),
      }),
    ).toBeTruthy();
    const rotatedRefreshToken = rotated.refresh_token as string;
    expect(typeof rotated.access_token).toBe("string");
    expect((rotated.access_token as string).split(".")).toHaveLength(1);
    expect(rotated.scope).toBe(tokenBody.scope);
    expect(rotatedRefreshToken).not.toBe(tokenBody.refresh_token);
    expect(rotationRows.results).toHaveLength(2);
    expect(
      rotationRows.results.filter((row) => row.revoked !== null),
    ).toHaveLength(1);
    expect(
      rotationRows.results.filter((row) => row.revoked === null),
    ).toHaveLength(1);
    expect(
      rotationRows.results.every(
        (row) =>
          row.token !== tokenBody.refresh_token &&
          row.token !== rotatedRefreshToken,
      ),
    ).toBe(true);
    const firstScopeDecode: unknown = JSON.parse(
      rotationRows.results.find((row) => row.revoked === null)!.scopes,
    );
    const storedScopes = (
      typeof firstScopeDecode === "string"
        ? JSON.parse(firstScopeDecode)
        : firstScopeDecode
    ) as string[];
    expect(storedScopes).toEqual(
      expect.arrayContaining(["resource:read", "offline_access"]),
    );

    const replay = await formPost("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokenBody.refresh_token,
      resource,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error?: string }).error).toBe(
      "invalid_grant",
    );

    const familyAfterReplay = await formPost("/oauth2/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotatedRefreshToken,
      resource,
    });
    expect(familyAfterReplay.status).toBe(400);
    expect(((await familyAfterReplay.json()) as { error?: string }).error).toBe(
      "invalid_grant",
    );

    const refreshRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM oauthRefreshToken WHERE clientId = ?",
    )
      .bind(clientId)
      .all<{ id: string }>();
    expect(refreshRows.results).toHaveLength(0);
  });
});
