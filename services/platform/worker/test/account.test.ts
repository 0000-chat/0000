import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, PLATFORM_SESSION_FRESH_AGE_SECONDS } from "../../src/auth";
import { opaqueSecret } from "../../src/platform-state";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;
const googleClientId = "platform-t02-google-client";
let githubIdentity = {
  id: 812345,
  login: "platform-t02-github",
  name: "GitHub Account",
  email: "github@example.test",
  verified: true,
};
const mutableTestEnv = testEnv as unknown as Record<string, string>;

function setSignupSettings(
  deploymentMode: "managed" | "self-hosted",
  signupPolicy: "open" | "invite-only",
): void {
  mutableTestEnv.PLATFORM_DEPLOYMENT_MODE = deploymentMode;
  mutableTestEnv.PLATFORM_SIGNUP_POLICY = signupPolicy;
}

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const all = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const cookie of all) {
      const pair = cookie.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) {
        cookies.set(pair.slice(0, separator), pair);
      }
    }
  }
  return [...cookies.values()].join("; ");
}

function mergeCookieStrings(...values: string[]): string {
  const cookies = new Map<string, string>();
  for (const value of values) {
    for (const pair of value.split(/;\s*/)) {
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
  }
  return [...cookies.values()].join("; ");
}

function base64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function googleIdToken(): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: googleClientId,
      sub: "google-subject-2001",
      email: "google@example.test",
      email_verified: true,
      name: "Google Account",
      picture: "https://images.example.test/google.png",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${claims}.synthetic-provider-signature`;
}

async function startSocialLogin(
  provider: "google" | "github",
  cookie = "",
): Promise<Response> {
  return SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: testEnv.PLATFORM_BASE_URL,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      provider,
      callbackURL: "http://localhost/account",
    }),
  });
}

async function completeSocialCallback(
  provider: "google" | "github",
  start: Response,
  code: string,
  existingCookie = "",
): Promise<Response> {
  const startBody = (await start.clone().json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();
  return SELF.fetch(
    `http://localhost/api/auth/callback/${provider}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`,
    {
      headers: {
        cookie: mergeCookieStrings(existingCookie, cookiesFrom(start)),
        origin: testEnv.PLATFORM_BASE_URL,
      },
      redirect: "manual",
    },
  );
}

async function attemptGithubLogin(
  identity: typeof githubIdentity,
  code: string,
): Promise<Response> {
  githubIdentity = identity;
  const start = await startSocialLogin("github");
  expect(start.status).toBe(200);
  return completeSocialCallback("github", start, code);
}

async function insertInvitation(
  organizationId: string,
  inviterId: string,
  email: string,
  expiresAt: number,
): Promise<void> {
  await testEnv.IDENTITY_DB.prepare(
    `INSERT INTO invitation
       (id, organizationId, email, role, status, expiresAt, createdAt, inviterId)
     VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      organizationId,
      email,
      expiresAt,
      Date.now(),
      inviterId,
    )
    .run();
}

async function signupRows(
  email: string,
  providerAccountId: string,
): Promise<{ users: number; accounts: number }> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM "user" WHERE email = ?) AS users,
       (SELECT COUNT(*) FROM account WHERE accountId = ?) AS accounts`,
  )
    .bind(email, providerAccountId)
    .first<{ users: number; accounts: number }>();
  if (!rows) throw new Error("Signup row counts are unavailable");
  return rows;
}

async function accountSnapshot(): Promise<Record<string, unknown>[]> {
  const accounts = await testEnv.IDENTITY_DB.prepare(
    `SELECT id, providerId, accountId, userId, accessToken, refreshToken,
            idToken, scope, accessTokenExpiresAt, refreshTokenExpiresAt
     FROM account ORDER BY id`,
  ).all<Record<string, unknown>>();
  return accounts.results;
}

describe("Platform human account providers", () => {
  beforeEach(() => {
    githubIdentity = {
      id: 812345,
      login: "platform-t02-github",
      name: "GitHub Account",
      email: "github@example.test",
      verified: true,
    };
    setSignupSettings("self-hosted", "open");
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
          return Response.json({
            access_token: "provider-test-google-token",
            expires_in: 3600,
            id_token: googleIdToken(),
            token_type: "Bearer",
          });
        }
        if (
          url.hostname === "github.com" &&
          url.pathname === "/login/oauth/access_token"
        ) {
          return Response.json({
            access_token: "provider-test-github-token",
            token_type: "bearer",
            scope: "read:user user:email",
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({
            id: githubIdentity.id,
            login: githubIdentity.login,
            name: githubIdentity.name,
            avatar_url: null,
          });
        }
        if (
          url.hostname === "api.github.com" &&
          url.pathname === "/user/emails"
        ) {
          return Response.json([
            {
              email: githubIdentity.email,
              primary: true,
              verified: githubIdentity.verified,
            },
          ]);
        }
        throw new Error(
          `Unexpected provider request: ${url.origin}${url.pathname}`,
        );
      }),
    );
  });

  it("supports Google/GitHub account lifecycle, signup controls, profile safety, and logout", async () => {
    const start = await SELF.fetch("http://localhost/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: testEnv.PLATFORM_BASE_URL,
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "http://localhost/account",
      }),
    });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { url: string };
    const state = new URL(startBody.url).searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await SELF.fetch(
      `http://localhost/api/auth/callback/google?code=google-provider-code&state=${encodeURIComponent(state!)}`,
      {
        headers: {
          cookie: cookiesFrom(start),
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      },
    );
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!).pathname).toBe(
      "/account",
    );
    let cookies = cookiesFrom(callback);
    expect(cookies).toContain("better-auth.session_token=");

    const sessionResponse = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      { headers: { cookie: cookies, origin: testEnv.PLATFORM_BASE_URL } },
    );
    expect(sessionResponse.status).toBe(200);
    let session = (await sessionResponse.json()) as {
      user?: { id: string; email: string; name: string };
      session?: { id: string };
    };
    expect(session.user).toMatchObject({
      email: "google@example.test",
      name: "Google Account",
    });
    expect(session.user?.id).toBeTruthy();
    expect(session.session?.id).toBeTruthy();

    const loginPage = await SELF.fetch("http://localhost/login");
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    expect(loginHtml).toContain('data-auth-provider="google"');
    expect(loginHtml).toContain('data-auth-provider="github"');
    expect(loginHtml).toContain("/account.js");
    expect(loginHtml).toContain("/account.css");

    const accountPages = await Promise.all(
      Array.from({ length: 6 }, () =>
        SELF.fetch("http://localhost/account", {
          headers: { cookie: cookies },
        }),
      ),
    );
    expect(accountPages.every((response) => response.status === 200)).toBe(
      true,
    );
    const accountHtml = await accountPages[0]!.text();
    expect(accountHtml).toContain("google@example.test");
    expect(accountHtml).toContain("Google Account&#39;s organization");
    expect(accountHtml).toContain("Google");
    expect(accountHtml).not.toContain("provider-test-google-token");

    const accountScript = await SELF.fetch("http://localhost/account.js");
    const scriptBody = await accountScript.text();
    expect(accountScript.headers.get("content-type")).toContain(
      "application/javascript",
    );
    expect(() => new Function(scriptBody)).not.toThrow();
    expect(scriptBody).not.toMatch(
      /localStorage|sessionStorage|accessToken|refreshToken|bearer/i,
    );

    githubIdentity = {
      id: 812356,
      login: "link-after-logout",
      name: "Link After Logout",
      email: "link-after-logout@example.test",
      verified: true,
    };
    const linkBeforeLogout = await SELF.fetch(
      "http://localhost/api/auth/link-social",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
        }),
      },
    );
    expect(linkBeforeLogout.status).toBe(200);
    const accountsBeforeLogoutLinkCallback = await accountSnapshot();
    const logoutBeforeLinkCallback = await SELF.fetch(
      "http://localhost/api/auth/sign-out",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ disableRedirect: true }),
      },
    );
    expect(logoutBeforeLinkCallback.status).toBe(200);
    const linkCallbackAfterLogout = await completeSocialCallback(
      "github",
      linkBeforeLogout,
      "link-callback-after-logout",
    );
    const linkCallbackAfterLogoutUrl = new URL(
      linkCallbackAfterLogout.headers.get("location")!,
    );
    expect(linkCallbackAfterLogoutUrl.searchParams.get("error")).toBe(
      "link_session_required",
    );
    expect(
      await testEnv.IDENTITY_DB.prepare(
        "SELECT id FROM account WHERE accountId = ?",
      )
        .bind("812356")
        .first(),
    ).toBeNull();
    expect(await accountSnapshot()).toEqual(accountsBeforeLogoutLinkCallback);

    const resumedLogin = await startSocialLogin("google");
    const resumedCallback = await completeSocialCallback(
      "google",
      resumedLogin,
      "login-after-link-logout",
    );
    expect(resumedCallback.status).toBe(302);
    cookies = cookiesFrom(resumedCallback);
    const resumedSessionResponse = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      { headers: { cookie: cookies, origin: testEnv.PLATFORM_BASE_URL } },
    );
    expect(resumedSessionResponse.status).toBe(200);
    session = (await resumedSessionResponse.json()) as typeof session;

    githubIdentity = {
      id: 812357,
      login: "link-to-disabled-user",
      name: "Link To Disabled User",
      email: "link-to-disabled-user@example.test",
      verified: true,
    };
    const linkBeforeDisable = await SELF.fetch(
      "http://localhost/api/auth/link-social",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
        }),
      },
    );
    expect(linkBeforeDisable.status).toBe(200);
    const linkBeforeDisableBody = (await linkBeforeDisable.json()) as {
      url: string;
    };
    const linkBeforeDisableState = new URL(
      linkBeforeDisableBody.url,
    ).searchParams.get("state");
    expect(linkBeforeDisableState).toBeTruthy();
    const callbackAfterDisableUrl = `http://localhost/api/auth/callback/github?code=link-callback-after-disable&state=${encodeURIComponent(linkBeforeDisableState!)}`;
    const linkCallbackCookies = mergeCookieStrings(
      cookies,
      cookiesFrom(linkBeforeDisable),
    );
    const accountsBeforeDisableCallback = await accountSnapshot();
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), session.user?.id)
      .run();
    const retainedDisabledUserSession = await testEnv.IDENTITY_DB.prepare(
      'SELECT id FROM "session" WHERE id = ?',
    )
      .bind(session.session?.id)
      .first<{ id: string }>();
    expect(retainedDisabledUserSession?.id).toBe(session.session?.id);
    const workerDisabledLinkCallback = await SELF.fetch(
      callbackAfterDisableUrl,
      {
        headers: {
          cookie: linkCallbackCookies,
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      },
    );
    expect(workerDisabledLinkCallback.status).toBe(401);
    expect(await workerDisabledLinkCallback.json()).toEqual({
      error: "disabled_user",
    });
    const rawDisabledLinkCallback = await createAuth(testEnv).handler(
      new Request(callbackAfterDisableUrl, {
        headers: {
          cookie: linkCallbackCookies,
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      }),
    );
    expect(rawDisabledLinkCallback.status).toBe(302);
    expect(
      new URL(
        rawDisabledLinkCallback.headers.get("location")!,
      ).searchParams.get("error"),
    ).toBe("link_session_required");
    expect(await accountSnapshot()).toEqual(accountsBeforeDisableCallback);
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(session.user?.id)
      .run();

    const badStateStart = await startSocialLogin("github");
    const badStateCallback = await SELF.fetch(
      "http://localhost/api/auth/callback/github?code=forged-state-code&state=forged-state-value",
      {
        headers: {
          cookie: cookiesFrom(badStateStart),
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      },
    );
    expect(badStateCallback.status).toBe(302);
    expect(
      new URL(badStateCallback.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBeTruthy();
    expect(cookiesFrom(badStateCallback)).not.toContain(
      "better-auth.session_token=",
    );

    const unsafeCallback = await SELF.fetch(
      "http://localhost/api/auth/sign-in/social/",
      {
        method: "POST",
        headers: {
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "https://attacker.example/steal",
        }),
      },
    );
    expect(unsafeCallback.status).toBe(400);
    expect(await unsafeCallback.json()).toEqual({
      error: "invalid_callback_destination",
    });
    const crossOriginProfile = await SELF.fetch(
      "http://localhost/api/account/profile/",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Forged", avatarUrl: "" }),
      },
    );
    expect(crossOriginProfile.status).toBe(403);

    const denyAdminClient = await SELF.fetch(
      "http://localhost/api/auth/oauth2/create-client",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.test/callback"],
        }),
      },
    );
    const denyAdminResources = await SELF.fetch(
      "http://localhost/api/auth/admin/oauth2/resources",
      { headers: { cookie: cookies } },
    );
    expect(denyAdminClient.status, await denyAdminClient.clone().text()).toBe(
      401,
    );
    expect(denyAdminResources.status).toBe(404);

    const accounts = await testEnv.IDENTITY_DB.prepare(
      "SELECT providerId, accountId, userId, accessToken FROM account",
    ).all<{
      providerId: string;
      accountId: string;
      userId: string;
      accessToken: string;
    }>();
    expect(accounts.results).toEqual([
      {
        providerId: "google",
        accountId: "google-subject-2001",
        userId: session.user?.id,
        accessToken: expect.any(String),
      },
    ]);
    expect(accounts.results[0]?.accessToken).not.toBe(
      "provider-test-google-token",
    );

    githubIdentity = {
      id: 812346,
      login: "google-email-github",
      name: "Google Email GitHub",
      email: "google@example.test",
      verified: true,
    };
    const implicitStart = await startSocialLogin("github");
    expect(implicitStart.status).toBe(200);
    const implicitCallback = await completeSocialCallback(
      "github",
      implicitStart,
      "same-email-github-login",
    );
    expect(implicitCallback.status).toBe(302);
    const implicitLocation = new URL(implicitCallback.headers.get("location")!);
    expect(implicitLocation.searchParams.get("error")).toBe(
      "account_not_linked",
    );
    const usersAfterImplicitAttempt = await testEnv.IDENTITY_DB.prepare(
      'SELECT id FROM "user"',
    ).all<{ id: string }>();
    const accountsAfterImplicitAttempt = await testEnv.IDENTITY_DB.prepare(
      "SELECT providerId, accountId, userId FROM account",
    ).all<{ providerId: string; accountId: string; userId: string }>();
    expect(usersAfterImplicitAttempt.results).toHaveLength(1);
    expect(accountsAfterImplicitAttempt.results).toHaveLength(1);

    const switchedProviderLogin = await attemptGithubLogin(
      {
        id: 812354,
        login: "switched-session-user",
        name: "Switched Session User",
        email: "switched-session@example.test",
        verified: true,
      },
      "switched-session-user-signin",
    );
    expect(switchedProviderLogin.status).toBe(302);
    const switchedUserCookies = cookiesFrom(switchedProviderLogin);
    githubIdentity = {
      id: 812355,
      login: "link-to-original-user",
      name: "Link To Original User",
      email: "different-linked@example.test",
      verified: true,
    };
    const switchedSessionLinkStart = await SELF.fetch(
      "http://localhost/api/auth/link-social",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
        }),
      },
    );
    expect(switchedSessionLinkStart.status).toBe(200);
    const accountsBeforeSwitchedSessionCallback = await accountSnapshot();
    const switchedSessionCallback = await completeSocialCallback(
      "github",
      switchedSessionLinkStart,
      "switched-session-link-callback",
      switchedUserCookies,
    );
    const switchedSessionCallbackUrl = new URL(
      switchedSessionCallback.headers.get("location")!,
    );
    expect(switchedSessionCallbackUrl.searchParams.get("error")).toBe(
      "link_session_required",
    );
    expect(await accountSnapshot()).toEqual(
      accountsBeforeSwitchedSessionCallback,
    );

    githubIdentity = {
      id: 812347,
      login: "different-email-github",
      name: "Different Email GitHub",
      email: "linked@example.test",
      verified: true,
    };
    const linkStart = await SELF.fetch(
      "http://localhost/api/auth/link-social",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "http://localhost/account",
        }),
      },
    );
    expect(linkStart.status).toBe(200);
    const linkCallback = await completeSocialCallback(
      "github",
      linkStart,
      "deliberate-different-email-link",
      cookies,
    );
    expect(linkCallback.status).toBe(302);
    expect(new URL(linkCallback.headers.get("location")!).pathname).toBe(
      "/account",
    );
    const linkedAccounts = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, providerId, accountId, userId FROM account WHERE userId = ? ORDER BY providerId",
    )
      .bind(session.user?.id)
      .all<{
        id: string;
        providerId: string;
        accountId: string;
        userId: string;
      }>();
    expect(linkedAccounts.results).toEqual([
      {
        id: expect.any(String),
        providerId: "github",
        accountId: "812347",
        userId: session.user?.id,
      },
      {
        id: expect.any(String),
        providerId: "google",
        accountId: "google-subject-2001",
        userId: session.user?.id,
      },
    ]);

    const rawUnlinkPaths = await Promise.all(
      ["/api/auth/unlink-account", "/api/auth/unlink-account/"].map((path) =>
        createAuth(testEnv).handler(
          new Request(`http://localhost${path}`, {
            method: "POST",
            headers: {
              cookie: cookies,
              origin: testEnv.PLATFORM_BASE_URL,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              accountId: linkedAccounts.results[0]?.id,
            }),
          }),
        ),
      ),
    );
    expect(rawUnlinkPaths.map((response) => response.status)).toEqual([
      404, 404,
    ]);
    expect(
      (
        await testEnv.IDENTITY_DB.prepare(
          "SELECT id FROM account WHERE userId = ?",
        )
          .bind(session.user?.id)
          .all()
      ).results,
    ).toHaveLength(2);

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "session" SET createdAt = ? WHERE id = ?',
    )
      .bind(
        Date.now() - (PLATFORM_SESSION_FRESH_AGE_SECONDS + 1) * 1000,
        session.session?.id,
      )
      .run();
    const staleUnlink = await SELF.fetch(
      "http://localhost/api/auth/unlink-account",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: linkedAccounts.results[0]?.id,
        }),
      },
    );
    expect(staleUnlink.status).toBe(403);
    expect(await staleUnlink.json()).toEqual({ error: "session_not_fresh" });
    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "session" SET createdAt = ? WHERE id = ?',
    )
      .bind(Date.now(), session.session?.id)
      .run();
    const crossOriginUnlink = await SELF.fetch(
      "http://localhost/api/auth/unlink-account",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: linkedAccounts.results[0]?.id }),
      },
    );
    expect(crossOriginUnlink.status).toBe(403);

    const concurrentUnlinks = await Promise.all([
      SELF.fetch("http://localhost/api/auth/unlink-account", {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: linkedAccounts.results[0]?.id }),
      }),
      SELF.fetch("http://localhost/api/auth/unlink-account/", {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: linkedAccounts.results[1]?.id }),
      }),
    ]);
    expect(concurrentUnlinks.map((response) => response.status).sort()).toEqual(
      [200, 400],
    );
    const remainingProviderAccounts = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, providerId, accountId FROM account WHERE userId = ?",
    )
      .bind(session.user?.id)
      .all<{ id: string; providerId: string; accountId: string }>();
    expect(remainingProviderAccounts.results).toHaveLength(1);
    const unlinkLastProvider = await SELF.fetch(
      "http://localhost/api/auth/unlink-account",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accountId: remainingProviderAccounts.results[0]?.id,
        }),
      },
    );
    expect(unlinkLastProvider.status).toBe(400);
    expect(await unlinkLastProvider.json()).toEqual({
      error: "failed_to_unlink_last_account",
    });
    expect(
      (
        await testEnv.IDENTITY_DB.prepare(
          "SELECT id FROM account WHERE userId = ?",
        )
          .bind(session.user?.id)
          .all()
      ).results,
    ).toHaveLength(1);

    setSignupSettings("managed", "invite-only");
    const managedSignup = await attemptGithubLogin(
      {
        id: 812348,
        login: "managed-signup",
        name: "Managed Signup",
        email: "managed@example.test",
        verified: true,
      },
      "managed-signup",
    );
    expect(managedSignup.status).toBe(302);
    expect(new URL(managedSignup.headers.get("location")!).pathname).toBe(
      "/account",
    );
    expect(cookiesFrom(managedSignup)).toContain("better-auth.session_token=");
    const managedGithubAccount = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM account WHERE accountId = ?",
    )
      .bind("812348")
      .first<{ id: string }>();
    expect(managedGithubAccount?.id).toBeTruthy();
    const foreignUnlink = await SELF.fetch(
      "http://localhost/api/auth/%75nlink-account/",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: managedGithubAccount!.id }),
      },
    );
    expect(foreignUnlink.status).toBe(400);
    expect(await foreignUnlink.json()).toEqual({ error: "account_not_found" });
    const foreignAccountStillExists = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM account WHERE id = ?",
    )
      .bind(managedGithubAccount!.id)
      .first<{ id: string }>();
    expect(foreignAccountStillExists?.id).toBe(managedGithubAccount!.id);

    setSignupSettings("self-hosted", "invite-only");
    const uninvited = await attemptGithubLogin(
      {
        id: 812349,
        login: "uninvited-signup",
        name: "Uninvited Signup",
        email: "uninvited@example.test",
        verified: true,
      },
      "uninvited-signup",
    );
    const uninvitedLocation = new URL(uninvited.headers.get("location")!);
    expect(uninvitedLocation.searchParams.get("error")).toBe(
      "signup_invitation_required",
    );
    const uninvitedPage = await SELF.fetch(
      `http://localhost/api/auth/error?error=${encodeURIComponent(uninvitedLocation.searchParams.get("error")!)}`,
    );
    expect(uninvitedPage.status).toBe(200);
    expect(await uninvitedPage.text()).toContain("Sign-up is invitation-only.");
    expect(await signupRows("uninvited@example.test", "812349")).toEqual({
      users: 0,
      accounts: 0,
    });

    const defaultOrganization = await testEnv.IDENTITY_DB.prepare(
      "SELECT organization_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(session.user?.id)
      .first<{ organization_id: string }>();
    expect(defaultOrganization?.organization_id).toBeTruthy();
    await insertInvitation(
      defaultOrganization!.organization_id,
      session.user!.id,
      "expired@example.test",
      Date.now() - 1000,
    );
    const expiredInvitation = await attemptGithubLogin(
      {
        id: 812350,
        login: "expired-invite-signup",
        name: "Expired Invitation Signup",
        email: "expired@example.test",
        verified: true,
      },
      "expired-invite-signup",
    );
    expect(
      new URL(expiredInvitation.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("signup_invitation_required");
    expect(await signupRows("expired@example.test", "812350")).toEqual({
      users: 0,
      accounts: 0,
    });

    await insertInvitation(
      defaultOrganization!.organization_id,
      session.user!.id,
      "unverified@example.test",
      Date.now() + 60_000,
    );
    const unverifiedInvitation = await attemptGithubLogin(
      {
        id: 812351,
        login: "unverified-invite-signup",
        name: "Unverified Invitation Signup",
        email: "unverified@example.test",
        verified: false,
      },
      "unverified-invite-signup",
    );
    expect(
      new URL(unverifiedInvitation.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("email_not_verified");
    expect(await signupRows("unverified@example.test", "812351")).toEqual({
      users: 0,
      accounts: 0,
    });

    const suspendedOrganizationId = crypto.randomUUID();
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO organization (id, name, slug, createdAt, suspendedAt)
       VALUES (?, 'Suspended invitation org', ?, ?, ?)`,
    )
      .bind(
        suspendedOrganizationId,
        `suspended-${suspendedOrganizationId}`,
        Date.now(),
        Date.now(),
      )
      .run();
    await insertInvitation(
      suspendedOrganizationId,
      session.user!.id,
      "suspended-invite@example.test",
      Date.now() + 60_000,
    );
    const suspendedInvitation = await attemptGithubLogin(
      {
        id: 812352,
        login: "suspended-invite-signup",
        name: "Suspended Invitation Signup",
        email: "suspended-invite@example.test",
        verified: true,
      },
      "suspended-invite-signup",
    );
    expect(
      new URL(suspendedInvitation.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("signup_invitation_required");
    expect(await signupRows("suspended-invite@example.test", "812352")).toEqual(
      { users: 0, accounts: 0 },
    );

    await insertInvitation(
      defaultOrganization!.organization_id,
      session.user!.id,
      "ValidInvite@example.test",
      Date.now() + 60_000,
    );
    const validInvitation = await attemptGithubLogin(
      {
        id: 812353,
        login: "valid-invite-signup",
        name: "Valid Invitation Signup",
        email: "validinvite@example.test",
        verified: true,
      },
      "valid-invite-signup",
    );
    expect(validInvitation.status).toBe(302);
    expect(new URL(validInvitation.headers.get("location")!).pathname).toBe(
      "/account",
    );
    expect(cookiesFrom(validInvitation)).toContain(
      "better-auth.session_token=",
    );
    const invitationUser = await testEnv.IDENTITY_DB.prepare(
      'SELECT email FROM "user" WHERE id = (SELECT userId FROM account WHERE accountId = ?)',
    )
      .bind("812353")
      .first<{ email: string }>();
    expect(invitationUser?.email).toBe("validinvite@example.test");

    const remainingProvider = remainingProviderAccounts.results[0];
    expect(remainingProvider).toBeDefined();
    const existingProvider =
      remainingProvider?.providerId === "google" ? "google" : "github";
    if (existingProvider === "github") {
      githubIdentity = {
        id: Number(remainingProvider?.accountId),
        login: "existing-user-provider",
        name: "Existing User Provider",
        email: "linked@example.test",
        verified: true,
      };
    }
    const existingUserStart = await startSocialLogin(existingProvider);
    const existingUserCallback = await completeSocialCallback(
      existingProvider,
      existingUserStart,
      "existing-provider-sign-in",
    );
    expect(existingUserCallback.status).toBe(302);
    expect(
      new URL(existingUserCallback.headers.get("location")!).pathname,
    ).toBe("/account");

    const guestBootstrap = await SELF.fetch(
      "http://localhost/api/guest/bootstrap",
      {
        method: "POST",
        headers: { origin: testEnv.PLATFORM_BASE_URL },
      },
    );
    expect(guestBootstrap.status).toBe(201);
    const guestIdentity = (await guestBootstrap.json()) as {
      guestId: string;
      credential: string;
    };

    const profileName = '<img src=x onerror="alert(1)">';
    const invalidAvatar = await SELF.fetch(
      "http://localhost/api/account/profile",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Safe Name",
          avatarUrl: "http://images.example.test/avatar.png",
        }),
      },
    );
    expect(invalidAvatar.status).toBe(400);
    const updateProfile = await SELF.fetch(
      "http://localhost/api/account/profile",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: profileName,
          avatarUrl: "https://images.example.test/avatar.png",
          disabledAt: Date.now(),
          role: "admin",
        }),
      },
    );
    expect(updateProfile.status).toBe(200);
    const updatedAccount = await SELF.fetch("http://localhost/account", {
      headers: { cookie: cookies },
    });
    const updatedAccountHtml = await updatedAccount.text();
    expect(updatedAccountHtml).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(updatedAccountHtml).not.toContain(profileName);
    expect(updatedAccountHtml).toContain(
      "https://images.example.test/avatar.png",
    );

    const rawUserUpdate = await SELF.fetch(
      "http://localhost/api/auth/update-user",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: profileName,
          disabledAt: Date.now(),
          emailVerified: false,
          role: "admin",
          id: "attacker-user-id",
        }),
      },
    );
    expect([200, 400]).toContain(rawUserUpdate.status);
    const trailingRawUserUpdate = await SELF.fetch(
      "http://localhost/api/auth/update-user/",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ disabledAt: Date.now() }),
      },
    );
    expect(trailingRawUserUpdate.status).toBe(404);
    const rawEmailUpdate = await SELF.fetch(
      "http://localhost/api/auth/update-user",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: "attacker@example.test" }),
      },
    );
    expect(rawEmailUpdate.status).toBe(400);
    const rawOrganizationUpdate = await SELF.fetch(
      "http://localhost/api/auth/organization/update",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: defaultOrganization!.organization_id,
          data: {
            name: "Google Account's organization",
            suspendedAt: Date.now(),
          },
        }),
      },
    );
    expect(rawOrganizationUpdate.status).toBe(404);
    const trailingOrganizationUpdate = await SELF.fetch(
      "http://localhost/api/auth/organization/update/",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: defaultOrganization!.organization_id,
          data: { suspendedAt: Date.now() },
        }),
      },
    );
    expect(trailingOrganizationUpdate.status).toBe(404);
    const userLifecycleFields = await testEnv.IDENTITY_DB.prepare(
      'SELECT id, email, emailVerified, disabledAt FROM "user" WHERE id = ?',
    )
      .bind(session.user?.id)
      .first<{
        id: string;
        email: string;
        emailVerified: number;
        disabledAt: number | null;
      }>();
    const organizationLifecycleField = await testEnv.IDENTITY_DB.prepare(
      "SELECT suspendedAt FROM organization WHERE id = ?",
    )
      .bind(defaultOrganization!.organization_id)
      .first<{ suspendedAt: number | null }>();
    expect(userLifecycleFields).toEqual({
      id: session.user?.id,
      email: "google@example.test",
      emailVerified: 1,
      disabledAt: null,
    });
    expect(organizationLifecycleField?.suspendedAt).toBeNull();

    const service: TestService = {
      serviceId: "platform-t02-account-test-service",
      audience: "https://account-test.0000.test",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["resource:read"],
    };
    await registerTestService(testEnv.IDENTITY_DB, service);
    const guestGrantResponse = await SELF.fetch(
      "http://localhost/internal/v1/guest-grants",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.guestGrantIssuer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          guestCredential: guestIdentity.credential,
          resourceId: "t02-guest-resource",
          resourceOwnerId: guestIdentity.guestId,
          capabilities: ["resource:read"],
        }),
      },
    );
    expect(guestGrantResponse.status).toBe(201);
    const guestGrant = (await guestGrantResponse.json()) as {
      credential: string;
    };
    const issueCredential = async (): Promise<{
      credential: string;
      credentialId: string;
    }> => {
      const response = await SELF.fetch("http://localhost/api/credentials", {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceId: service.serviceId,
          organizationId: defaultOrganization!.organization_id,
          capabilities: ["resource:read"],
        }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json() as Promise<{
        credential: string;
        credentialId: string;
      }>;
    };
    const issued = await issueCredential();
    const authenticateCredential = async (): Promise<Response> =>
      SELF.fetch("http://localhost/internal/v1/authenticate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.verifier}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credential: issued.credential }),
      });
    const authenticateGuestCredential = async (): Promise<Response> =>
      SELF.fetch("http://localhost/internal/v1/authenticate", {
        method: "POST",
        headers: {
          authorization: `Bearer ${service.verifier}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ credential: guestGrant.credential }),
      });

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = ? WHERE id = ?",
    )
      .bind(Date.now(), defaultOrganization!.organization_id)
      .run();
    const suspendedAccount = await SELF.fetch("http://localhost/account", {
      headers: { cookie: cookies },
    });
    expect(await suspendedAccount.text()).toContain(
      "This organization is suspended and access is unavailable.",
    );
    const deniedCredentialIssue = await SELF.fetch(
      "http://localhost/api/credentials",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceId: service.serviceId,
          organizationId: defaultOrganization!.organization_id,
          capabilities: ["resource:read"],
        }),
      },
    );
    expect(deniedCredentialIssue.status).toBe(403);
    const rejectedWhileSuspended = await authenticateCredential();
    expect(rejectedWhileSuspended.status).toBe(401);

    await testEnv.IDENTITY_DB.prepare(
      "UPDATE organization SET suspendedAt = NULL WHERE id = ?",
    )
      .bind(defaultOrganization!.organization_id)
      .run();
    expect((await authenticateCredential()).status).toBe(200);
    expect((await authenticateGuestCredential()).status).toBe(200);

    const crossOriginLogout = await SELF.fetch(
      "http://localhost/api/auth/sign-out",
      {
        method: "POST",
        headers: {
          cookie: cookies,
          origin: "https://attacker.example",
        },
      },
    );
    expect(crossOriginLogout.status).toBe(403);
    const logout = await SELF.fetch("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: cookies,
        origin: testEnv.PLATFORM_BASE_URL,
      },
    });
    expect(logout.status).toBe(200);
    const sessionAfterLogout = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      { headers: { cookie: cookies } },
    );
    expect(await sessionAfterLogout.json()).toBeNull();
    expect((await authenticateCredential()).status).toBe(200);
    expect((await authenticateGuestCredential()).status).toBe(200);

    const receiptMembership = await testEnv.IDENTITY_DB.prepare(
      "SELECT membership_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(session.user?.id)
      .first<{ membership_id: string }>();
    await testEnv.IDENTITY_DB.prepare("DELETE FROM member WHERE id = ?")
      .bind(receiptMembership?.membership_id)
      .run();
    const existingUserStartAfterLogout = await startSocialLogin("google");
    const existingUserCallbackAfterLogout = await completeSocialCallback(
      "google",
      existingUserStartAfterLogout,
      "post-logout-existing-google-sign-in",
    );
    expect(existingUserCallbackAfterLogout.status).toBe(302);
    const afterLogoutCookies = cookiesFrom(existingUserCallbackAfterLogout);
    const accountAfterMembershipRemoval = await SELF.fetch(
      "http://localhost/account",
      { headers: { cookie: afterLogoutCookies } },
    );
    expect(await accountAfterMembershipRemoval.text()).toContain(
      "You no longer have access to the default organization. Ask an owner to invite you again.",
    );
    const retainedMembership = await testEnv.IDENTITY_DB.prepare(
      "SELECT id FROM member WHERE id = ?",
    )
      .bind(receiptMembership?.membership_id)
      .all();
    expect(retainedMembership.results).toHaveLength(0);
    expect(
      (
        await SELF.fetch("http://localhost/api/me", {
          headers: { cookie: afterLogoutCookies },
        })
      ).status,
    ).toBe(200);

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), session.user?.id)
      .run();
    const disabledAccount = await testEnv.IDENTITY_DB.withSession(
      "first-primary",
    )
      .prepare('SELECT id, disabledAt FROM "user" WHERE id = ?')
      .bind(session.user?.id)
      .first<{ id: string; disabledAt: number | null }>();
    expect(disabledAccount?.disabledAt).not.toBeNull();
    const apiMeAfterDisable = await SELF.fetch("http://localhost/api/me", {
      headers: { cookie: afterLogoutCookies },
    });
    expect(apiMeAfterDisable.status).toBe(401);
    for (const [label, request] of [
      [
        "account page",
        SELF.fetch("http://localhost/account", {
          headers: { cookie: afterLogoutCookies },
          redirect: "manual",
        }),
      ],
      [
        "profile update",
        SELF.fetch("http://localhost/api/account/profile", {
          method: "POST",
          headers: {
            cookie: afterLogoutCookies,
            origin: testEnv.PLATFORM_BASE_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Disabled", avatarUrl: "" }),
        }),
      ],
      [
        "credential issue",
        SELF.fetch("http://localhost/api/credentials", {
          method: "POST",
          headers: {
            cookie: afterLogoutCookies,
            origin: testEnv.PLATFORM_BASE_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            serviceId: service.serviceId,
            organizationId: defaultOrganization!.organization_id,
            capabilities: ["resource:read"],
          }),
        }),
      ],
      [
        "Better Auth profile route",
        SELF.fetch("http://localhost/api/auth/update-user", {
          method: "POST",
          headers: {
            cookie: afterLogoutCookies,
            origin: testEnv.PLATFORM_BASE_URL,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Disabled" }),
        }),
      ],
    ] as const) {
      const response = await request;
      expect(response.status, label).toBe(label === "account page" ? 302 : 401);
      if (label === "account page") {
        expect(response.headers.get("location")).toBe("http://localhost/login");
      }
    }
    const disabledSessionRead = await SELF.fetch(
      "http://localhost/api/auth/get-session",
      { headers: { cookie: afterLogoutCookies } },
    );
    expect(disabledSessionRead.status).toBe(401);

    const disabledLoginStart = await startSocialLogin("google");
    const disabledLogin = await completeSocialCallback(
      "google",
      disabledLoginStart,
      "disabled-google-sign-in",
    );
    const disabledLoginLocation = new URL(
      disabledLogin.headers.get("location")!,
    );
    expect(disabledLoginLocation.searchParams.get("error")).toBe(
      "user_disabled",
    );
    expect(cookiesFrom(disabledLogin)).not.toContain(
      "better-auth.session_token=",
    );
    const disabledLogout = await SELF.fetch(
      "http://localhost/api/auth/sign-out",
      {
        method: "POST",
        headers: {
          cookie: afterLogoutCookies,
          origin: testEnv.PLATFORM_BASE_URL,
        },
      },
    );
    expect(disabledLogout.status).toBe(200);
  });
});
