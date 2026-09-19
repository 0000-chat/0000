import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testEnv = env as Cloudflare.Env;
const mutableTestEnv = testEnv as unknown as Record<string, string>;

interface GithubIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

interface GoogleIdentity {
  subject: string;
  name: string;
  email: string;
}

interface LoginAttempt {
  start: Response;
  callback: Response;
}

interface HumanSession {
  userId: string;
  email: string;
  cookie: string;
}

let githubIdentity: GithubIdentity = {
  id: 814900,
  login: "platform-human-probe-baseline",
  name: "Human Probe Baseline",
  email: "human-probe-baseline@example.test",
};
let googleIdentity: GoogleIdentity = {
  subject: "human-probe-google-baseline",
  name: "Human Probe Google Baseline",
  email: "human-probe-google-baseline@example.test",
};
let coordinateSharedLookup = false;
let sharedLookupCount = 0;
let sharedLookupOverlap = false;
let releaseSharedLookup: (() => void) | undefined;
let sharedLookupRelease = new Promise<void>((resolve) => {
  releaseSharedLookup = resolve;
});

function cookiesFrom(...responses: Response[]): string {
  const cookies = new Map<string, string>();
  for (const response of responses) {
    const all = response.headers.getSetCookie?.() ?? [
      response.headers.get("set-cookie") ?? "",
    ];
    for (const cookie of all) {
      const pair = cookie.split(";")[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) cookies.set(pair.slice(0, separator), pair);
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
      aud: testEnv.GOOGLE_CLIENT_ID,
      sub: googleIdentity.subject,
      email: googleIdentity.email,
      email_verified: true,
      name: googleIdentity.name,
      picture: null,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${claims}.synthetic-provider-signature`;
}

function providerLookupBarrier(): void {
  coordinateSharedLookup = true;
  sharedLookupCount = 0;
  sharedLookupOverlap = false;
  sharedLookupRelease = new Promise<void>((resolve) => {
    releaseSharedLookup = resolve;
  });
}

async function boundedProviderLookupBarrier(): Promise<void> {
  sharedLookupCount += 1;
  if (sharedLookupCount >= 2) {
    sharedLookupOverlap = true;
    releaseSharedLookup?.();
    return;
  }
  await Promise.race([
    sharedLookupRelease,
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
}

async function startSocialLogin(
  provider: "github" | "google" = "github",
  cookie = "",
): Promise<Response> {
  return SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      provider,
      callbackURL: "http://localhost/account",
    }),
  });
}

async function startLink(cookie: string): Promise<Response> {
  return SELF.fetch("http://localhost/api/auth/link-social", {
    method: "POST",
    headers: {
      cookie,
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "http://localhost/account",
    }),
  });
}

async function completeSocialCallback(
  start: Response,
  code: string,
  existingCookie = "",
  provider: "github" | "google" = "github",
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

async function socialLogin(
  identity: GithubIdentity,
  code: string,
): Promise<LoginAttempt> {
  githubIdentity = identity;
  const start = await startSocialLogin();
  expect(start.status).toBe(200);
  const callback = await completeSocialCallback(start, code);
  return { start, callback };
}

async function googleLogin(
  identity: GoogleIdentity,
  code: string,
): Promise<LoginAttempt> {
  googleIdentity = identity;
  const start = await startSocialLogin("google");
  expect(start.status).toBe(200);
  const callback = await completeSocialCallback(start, code, "", "google");
  return { start, callback };
}

async function sessionFor(cookie: string): Promise<{
  user?: { id: string; email: string };
  session?: { id: string };
}> {
  const response = await SELF.fetch("http://localhost/api/auth/get-session", {
    headers: { cookie, origin: testEnv.PLATFORM_BASE_URL },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    user?: { id: string; email: string };
    session?: { id: string };
  }>;
}

async function loginAs(
  identity: GithubIdentity,
  code: string,
): Promise<HumanSession> {
  const attempt = await socialLogin(identity, code);
  expect(attempt.callback.status).toBe(302);
  const cookie = cookiesFrom(attempt.callback);
  const session = await sessionFor(cookie);
  expect(session.user?.email).toBe(identity.email);
  expect(session.user?.id).toBeTruthy();
  return { userId: session.user!.id, email: identity.email, cookie };
}

async function providerRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (
    url.hostname === "github.com" &&
    url.pathname === "/login/oauth/access_token"
  ) {
    return Response.json({
      access_token: `human-probe-token-${githubIdentity.id}`,
      token_type: "bearer",
      scope: "read:user user:email",
    });
  }
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    return Response.json({
      access_token: `human-probe-google-token-${googleIdentity.subject}`,
      expires_in: 3600,
      id_token: googleIdToken(),
      token_type: "Bearer",
    });
  }
  if (url.hostname === "api.github.com" && url.pathname === "/user") {
    if (coordinateSharedLookup) await boundedProviderLookupBarrier();
    return Response.json({
      id: githubIdentity.id,
      login: githubIdentity.login,
      name: githubIdentity.name,
      avatar_url: null,
    });
  }
  if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
    const authorization = new Headers(init?.headers).get("authorization");
    expect(authorization).toContain(`human-probe-token-${githubIdentity.id}`);
    return Response.json([
      { email: githubIdentity.email, primary: true, verified: true },
    ]);
  }
  throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
}

async function accountRows(
  accountId: string,
  providerId = "github",
): Promise<
  Array<{ id: string; userId: string; providerId: string; accountId: string }>
> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    "SELECT id, userId, providerId, accountId FROM account WHERE providerId = ? AND accountId = ? ORDER BY id",
  )
    .bind(providerId, accountId)
    .all<{
      id: string;
      userId: string;
      providerId: string;
      accountId: string;
    }>();
  return rows.results;
}

async function userRows(
  email: string,
): Promise<Array<{ id: string; email: string }>> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    'SELECT id, email FROM "user" WHERE email = ? ORDER BY id',
  )
    .bind(email)
    .all<{ id: string; email: string }>();
  return rows.results;
}

async function sessionRows(userId: string): Promise<Array<{ id: string }>> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    'SELECT id FROM "session" WHERE userId = ? ORDER BY id',
  )
    .bind(userId)
    .all<{ id: string }>();
  return rows.results;
}

async function pendingRows(email: string): Promise<
  Array<{
    id: string;
    pendingSocialProviderId: string | null;
    pendingSocialSubject: string | null;
    disabledAt: number | null;
  }>
> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    'SELECT id, pendingSocialProviderId, pendingSocialSubject, disabledAt FROM "user" WHERE email = ? ORDER BY id',
  )
    .bind(email)
    .all<{
      id: string;
      pendingSocialProviderId: string | null;
      pendingSocialSubject: string | null;
      disabledAt: number | null;
    }>();
  return rows.results;
}

async function meFor(cookie: string): Promise<{
  userId: string;
  organizationId: string;
  membershipId: string;
}> {
  const response = await SELF.fetch("http://localhost/api/me", {
    headers: { cookie, origin: testEnv.PLATFORM_BASE_URL },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    userId: string;
    organizationId: string;
    membershipId: string;
  }>;
}

describe("human recovery evidence experiments", () => {
  beforeEach(() => {
    mutableTestEnv.PLATFORM_DEPLOYMENT_MODE = "self-hosted";
    mutableTestEnv.PLATFORM_SIGNUP_POLICY = "open";
    githubIdentity = {
      id: 814900,
      login: "platform-human-probe-baseline",
      name: "Human Probe Baseline",
      email: "human-probe-baseline@example.test",
    };
    googleIdentity = {
      subject: "human-probe-google-baseline",
      name: "Human Probe Google Baseline",
      email: "human-probe-google-baseline@example.test",
    };
    coordinateSharedLookup = false;
    sharedLookupCount = 0;
    sharedLookupOverlap = false;
    vi.stubGlobal("fetch", vi.fn(providerRequest));
  });

  it("recovers interrupted signup only with the same provider subject", async () => {
    const baseline = await loginAs(
      {
        id: 814900,
        login: "platform-human-probe-baseline",
        name: "Human Probe Baseline",
        email: "human-probe-baseline@example.test",
      },
      "human-probe-baseline-signin",
    );
    const baselineAccount = await accountRows("814900");
    expect(baselineAccount).toHaveLength(1);
    expect(baselineAccount[0]?.userId).toBe(baseline.userId);
    expect(await sessionRows(baseline.userId)).toHaveLength(1);

    const interruptedIdentity = {
      id: 814901,
      login: "platform-human-probe-interrupted",
      name: "Human Probe Interrupted",
      email: "human-probe-interrupted@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814901'
       BEGIN SELECT RAISE(ABORT, 'human recovery injected account failure'); END`,
    ).run();

    let failedAttempt: LoginAttempt;
    try {
      failedAttempt = await socialLogin(
        interruptedIdentity,
        "human-probe-interrupted-signin",
      );
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert",
      ).run();
    }

    const interruptedUsers = await userRows(interruptedIdentity.email);
    const interruptedAccounts = await accountRows("814901");
    const interruptedSessions = interruptedUsers[0]
      ? await sessionRows(interruptedUsers[0].id)
      : [];
    expect(interruptedUsers).toHaveLength(1);
    expect(interruptedAccounts).toHaveLength(0);
    expect(interruptedSessions).toHaveLength(0);
    expect(await pendingRows(interruptedIdentity.email)).toEqual([
      {
        id: interruptedUsers[0]?.id,
        pendingSocialProviderId: "github",
        pendingSocialSubject: "814901",
        disabledAt: null,
      },
    ]);

    const retry = await socialLogin(
      interruptedIdentity,
      "human-probe-interrupted-retry",
    );
    const retryLocation = retry.callback.headers.get("location");
    expect(retry.callback.status).toBe(302);
    expect(retryLocation).toBe("http://localhost/account");
    const recoveredCookie = cookiesFrom(retry.callback);
    const recoveredSession = await sessionFor(recoveredCookie);
    expect(recoveredSession.user?.id).toBe(interruptedUsers[0]?.id);
    expect(recoveredSession.user?.email).toBe(interruptedIdentity.email);
    expect(
      recoveredSession.user &&
        Object.hasOwn(recoveredSession.user, "pendingSocialProviderId"),
    ).toBe(false);
    expect(await userRows(interruptedIdentity.email)).toHaveLength(1);
    expect(await accountRows("814901")).toEqual([
      expect.objectContaining({
        userId: interruptedUsers[0]?.id,
        providerId: "github",
        accountId: "814901",
      }),
    ]);
    expect(await pendingRows(interruptedIdentity.email)).toEqual([
      expect.objectContaining({
        id: interruptedUsers[0]?.id,
        pendingSocialProviderId: null,
        pendingSocialSubject: null,
        disabledAt: null,
      }),
    ]);
    expect(
      interruptedUsers[0] ? await sessionRows(interruptedUsers[0].id) : [],
    ).toHaveLength(1);
    const recoveredMe = await meFor(recoveredCookie);
    expect(recoveredMe.userId).toBe(interruptedUsers[0]?.id);
    const receipt = await testEnv.IDENTITY_DB.prepare(
      "SELECT organization_id, membership_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(recoveredMe.userId)
      .first<{ organization_id: string; membership_id: string }>();
    expect(receipt).toEqual({
      organization_id: recoveredMe.organizationId,
      membership_id: recoveredMe.membershipId,
    });
    const owner = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, role FROM member WHERE id = ? AND userId = ?",
    )
      .bind(recoveredMe.membershipId, recoveredMe.userId)
      .first<{ id: string; role: string }>();
    expect(owner).toEqual({ id: recoveredMe.membershipId, role: "owner" });

    console.log(
      JSON.stringify({
        experiment: "interrupted-signup",
        baseline: {
          callbackStatus: 302,
          accounts: baselineAccount.length,
          sessions: (await sessionRows(baseline.userId)).length,
        },
        injectedFailure: {
          callbackStatus: failedAttempt!.callback.status,
          users: interruptedUsers.length,
          accounts: interruptedAccounts.length,
          sessions: interruptedSessions.length,
        },
        retry: {
          callbackStatus: retry.callback.status,
          error: null,
          users: (await userRows(interruptedIdentity.email)).length,
          accounts: (await accountRows("814901")).length,
          sessions: interruptedUsers[0]
            ? (await sessionRows(interruptedUsers[0].id)).length
            : 0,
          pendingBinding: (await pendingRows(interruptedIdentity.email))[0],
        },
      }),
    );
  });

  it("recovers interrupted Google signup with the exact provider subject", async () => {
    const identity = {
      subject: "human-probe-google-recovery",
      name: "Human Probe Google Recovery",
      email: "human-probe-google-recovery@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_google_account_insert
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'google' AND NEW.accountId = 'human-probe-google-recovery'
       BEGIN SELECT RAISE(ABORT, 'human recovery Google setup'); END`,
    ).run();
    try {
      const failed = await googleLogin(
        identity,
        "human-probe-google-recovery-signin",
      );
      expect(failed.callback.status).toBe(302);
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_google_account_insert",
      ).run();
    }

    const pendingUser = (await pendingRows(identity.email))[0];
    expect(pendingUser).toMatchObject({
      pendingSocialProviderId: "google",
      pendingSocialSubject: identity.subject,
      disabledAt: null,
    });
    expect(await accountRows(identity.subject, "google")).toHaveLength(0);

    const recovered = await googleLogin(
      identity,
      "human-probe-google-recovery-retry",
    );
    expect(recovered.callback.status).toBe(302);
    expect(recovered.callback.headers.get("location")).toBe(
      "http://localhost/account",
    );
    const recoveredCookie = cookiesFrom(recovered.callback);
    expect((await sessionFor(recoveredCookie)).user?.id).toBe(pendingUser?.id);
    expect(await accountRows(identity.subject, "google")).toEqual([
      expect.objectContaining({
        userId: pendingUser?.id,
        providerId: "google",
        accountId: identity.subject,
      }),
    ]);
    expect((await pendingRows(identity.email))[0]).toMatchObject({
      id: pendingUser?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
    });
  });

  it("rejects wrong subjects, stale state, and unsigned direct id tokens", async () => {
    const interruptedIdentity = {
      id: 814902,
      login: "platform-human-probe-negative",
      name: "Human Probe Negative",
      email: "human-probe-negative@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_negative
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814902'
       BEGIN SELECT RAISE(ABORT, 'human recovery negative setup'); END`,
    ).run();
    try {
      await socialLogin(interruptedIdentity, "human-probe-negative-signin");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_negative",
      ).run();
    }

    const interruptedUser = (await pendingRows(interruptedIdentity.email))[0];
    expect(interruptedUser).toMatchObject({
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814902",
      disabledAt: null,
    });

    const wrongSubject = {
      ...interruptedIdentity,
      id: 814903,
      login: "platform-human-probe-wrong-subject",
      name: "Human Probe Wrong Subject",
    };
    const wrongAttempt = await socialLogin(
      wrongSubject,
      "human-probe-negative-wrong-subject",
    );
    const wrongLocation = wrongAttempt.callback.headers.get("location");
    expect(wrongAttempt.callback.status).toBe(302);
    expect(new URL(wrongLocation!).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(await accountRows("814902")).toHaveLength(0);
    expect(await accountRows("814903")).toHaveLength(0);
    expect((await pendingRows(interruptedIdentity.email))[0]).toMatchObject({
      id: interruptedUser?.id,
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814902",
    });

    const staleStart = await startSocialLogin();
    const staleCallback = await SELF.fetch(
      "http://localhost/api/auth/callback/github?code=human-probe-stale&state=not-the-issued-state",
      {
        headers: {
          cookie: cookiesFrom(staleStart),
          origin: testEnv.PLATFORM_BASE_URL,
        },
        redirect: "manual",
      },
    );
    expect(staleCallback.status).toBe(302);
    expect(
      new URL(staleCallback.headers.get("location")!).searchParams.get("error"),
    ).toBeTruthy();
    expect(await accountRows("814902")).toHaveLength(0);
    expect(await sessionRows(interruptedUser!.id)).toHaveLength(0);

    const unsignedDirectIdToken = await SELF.fetch(
      "http://localhost/api/auth/sign-in/social",
      {
        method: "POST",
        headers: {
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "http://localhost/account",
          idToken: {
            token: "unsigned-direct-id-token",
            user: { email: interruptedIdentity.email },
          },
        }),
      },
    );
    expect(unsignedDirectIdToken.status).toBe(401);
    expect(await accountRows("814902")).toHaveLength(0);
    expect((await pendingRows(interruptedIdentity.email))[0]).toMatchObject({
      id: interruptedUser?.id,
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814902",
    });

    const recovered = await socialLogin(
      interruptedIdentity,
      "human-probe-negative-recovery",
    );
    expect(recovered.callback.headers.get("location")).toBe(
      "http://localhost/account",
    );
    expect(await accountRows("814902")).toHaveLength(1);
    expect(await pendingRows(interruptedIdentity.email)).toEqual([
      expect.objectContaining({
        id: interruptedUser?.id,
        pendingSocialProviderId: null,
        pendingSocialSubject: null,
      }),
    ]);
  });

  it("keeps the marker through a failed recovery and denies disabled users", async () => {
    const identity = {
      id: 814904,
      login: "platform-human-probe-disabled",
      name: "Human Probe Disabled",
      email: "human-probe-disabled@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_atomic
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814904'
       BEGIN SELECT RAISE(ABORT, 'human recovery atomic setup'); END`,
    ).run();
    try {
      await socialLogin(identity, "human-probe-atomic-signin");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_atomic",
      ).run();
    }

    const user = (await pendingRows(identity.email))[0];
    expect(user).toMatchObject({
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814904",
      disabledAt: null,
    });

    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_recovery_atomic
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814904'
       BEGIN SELECT RAISE(ABORT, 'human recovery atomic retry failure'); END`,
    ).run();
    let blockedRetry: LoginAttempt | undefined;
    let blockedError: unknown;
    try {
      blockedRetry = await socialLogin(
        identity,
        "human-probe-atomic-blocked-retry",
      );
    } catch (error) {
      blockedError = error;
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_recovery_atomic",
      ).run();
    }
    expect(blockedRetry || blockedError).toBeTruthy();
    expect(await accountRows("814904")).toHaveLength(0);
    expect((await pendingRows(identity.email))[0]).toMatchObject({
      id: user?.id,
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814904",
    });

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = ? WHERE id = ?',
    )
      .bind(Date.now(), user?.id)
      .run();
    const disabledRetry = await socialLogin(
      identity,
      "human-probe-disabled-retry",
    );
    const disabledLocation = disabledRetry.callback.headers.get("location");
    expect(disabledRetry.callback.status).toBe(302);
    expect(new URL(disabledLocation!).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(await accountRows("814904")).toHaveLength(0);
    expect(await sessionRows(user!.id)).toHaveLength(0);
    expect((await pendingRows(identity.email))[0]).toMatchObject({
      id: user?.id,
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814904",
      disabledAt: expect.any(Number),
    });

    await testEnv.IDENTITY_DB.prepare(
      'UPDATE "user" SET disabledAt = NULL WHERE id = ?',
    )
      .bind(user?.id)
      .run();
    const recovered = await socialLogin(
      identity,
      "human-probe-disabled-recovery",
    );
    expect(recovered.callback.headers.get("location")).toBe(
      "http://localhost/account",
    );
    expect(await accountRows("814904")).toHaveLength(1);
    expect((await pendingRows(identity.email))[0]).toMatchObject({
      id: user?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
      disabledAt: null,
    });
  });

  it("does not recover a pending signup during a revoked explicit link callback", async () => {
    const pendingIdentity = {
      id: 814920,
      login: "platform-human-probe-revoked-pending",
      name: "Human Probe Revoked Pending",
      email: "human-probe-revoked-pending@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_revoked
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814920'
       BEGIN SELECT RAISE(ABORT, 'human recovery revoked-link setup'); END`,
    ).run();
    try {
      await socialLogin(pendingIdentity, "human-probe-revoked-pending-signin");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_revoked",
      ).run();
    }

    const pendingUser = (await pendingRows(pendingIdentity.email))[0];
    expect(pendingUser).toMatchObject({
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814920",
      disabledAt: null,
    });
    expect(await accountRows("814920")).toHaveLength(0);

    const linkUser = await loginAs(
      {
        id: 814921,
        login: "platform-human-probe-revoked-linker",
        name: "Human Probe Revoked Linker",
        email: "human-probe-revoked-linker@example.test",
      },
      "human-probe-revoked-linker-signin",
    );
    const linkStart = await startLink(linkUser.cookie);
    expect(linkStart.status).toBe(200);
    githubIdentity = pendingIdentity;

    const signOut = await SELF.fetch("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: linkUser.cookie,
        origin: testEnv.PLATFORM_BASE_URL,
      },
    });
    expect(signOut.status).toBe(200);

    const revokedCallback = await completeSocialCallback(
      linkStart,
      "human-probe-revoked-link-callback",
      linkUser.cookie,
    );
    expect(revokedCallback.status).toBe(302);
    expect(
      new URL(revokedCallback.headers.get("location")!).searchParams.get(
        "error",
      ),
    ).toBe("link_session_required");
    expect(await accountRows("814920")).toHaveLength(0);
    expect((await pendingRows(pendingIdentity.email))[0]).toMatchObject({
      id: pendingUser?.id,
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814920",
    });
  });

  it("keeps a pending owner ahead of a competing explicit link claim", async () => {
    const pendingIdentity = {
      id: 814922,
      login: "platform-human-probe-mixed-pending",
      name: "Human Probe Mixed Pending",
      email: "human-probe-mixed-pending@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_mixed
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814922'
       BEGIN SELECT RAISE(ABORT, 'human recovery mixed setup'); END`,
    ).run();
    try {
      await socialLogin(pendingIdentity, "human-probe-mixed-pending-signin");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_mixed",
      ).run();
    }

    const pendingUser = (await pendingRows(pendingIdentity.email))[0];
    expect(pendingUser).toMatchObject({
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814922",
    });

    const linkUser = await loginAs(
      {
        id: 814923,
        login: "platform-human-probe-mixed-linker",
        name: "Human Probe Mixed Linker",
        email: "human-probe-mixed-linker@example.test",
      },
      "human-probe-mixed-linker-signin",
    );
    const linkStart = await startLink(linkUser.cookie);
    const retryStart = await startSocialLogin();
    expect(linkStart.status).toBe(200);
    expect(retryStart.status).toBe(200);

    githubIdentity = pendingIdentity;
    providerLookupBarrier();
    let retryCallback: Response;
    let linkCallback: Response;
    try {
      [linkCallback, retryCallback] = await Promise.all([
        completeSocialCallback(
          linkStart,
          "human-probe-mixed-link-callback",
          linkUser.cookie,
        ),
        completeSocialCallback(retryStart, "human-probe-mixed-retry"),
      ]);
    } finally {
      coordinateSharedLookup = false;
    }

    expect(sharedLookupOverlap).toBe(true);
    expect(sharedLookupCount).toBe(2);
    expect([302, 500]).toContain(linkCallback.status);
    expect(retryCallback.status).toBe(302);
    const owners = await accountRows("814922");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(pendingUser?.id);
    expect((await pendingRows(pendingIdentity.email))[0]).toMatchObject({
      id: pendingUser?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
    });
    expect(await accountRows("814923")).toHaveLength(1);
    expect((await sessionFor(linkUser.cookie)).user?.id).toBe(linkUser.userId);
  });

  it("converges simultaneous recovery retries on one pending owner", async () => {
    const identity = {
      id: 814924,
      login: "platform-human-probe-simultaneous-retry",
      name: "Human Probe Simultaneous Retry",
      email: "human-probe-simultaneous-retry@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_simultaneous
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814924'
       BEGIN SELECT RAISE(ABORT, 'human recovery simultaneous setup'); END`,
    ).run();
    try {
      await socialLogin(identity, "human-probe-simultaneous-initial");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_simultaneous",
      ).run();
    }

    const pendingUser = (await pendingRows(identity.email))[0];
    expect(pendingUser).toMatchObject({
      pendingSocialProviderId: "github",
      pendingSocialSubject: "814924",
    });
    const firstStart = await startSocialLogin();
    const secondStart = await startSocialLogin();
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);

    githubIdentity = identity;
    providerLookupBarrier();
    let callbacks: [Response, Response];
    try {
      callbacks = (await Promise.all([
        completeSocialCallback(firstStart, "human-probe-simultaneous-one"),
        completeSocialCallback(secondStart, "human-probe-simultaneous-two"),
      ])) as [Response, Response];
    } finally {
      coordinateSharedLookup = false;
    }

    expect(sharedLookupOverlap).toBe(true);
    expect(sharedLookupCount).toBe(2);
    expect(callbacks.map((callback) => callback.status)).toEqual([302, 302]);
    expect(
      callbacks.map((callback) => callback.headers.get("location")),
    ).toEqual(["http://localhost/account", "http://localhost/account"]);
    expect(await accountRows("814924")).toEqual([
      expect.objectContaining({
        userId: pendingUser?.id,
        providerId: "github",
        accountId: "814924",
      }),
    ]);
    expect((await pendingRows(identity.email))[0]).toMatchObject({
      id: pendingUser?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
    });
    const sessions = await sessionRows(pendingUser!.id);
    expect(sessions).toHaveLength(2);
    const firstMe = await meFor(cookiesFrom(callbacks[0]!));
    const secondMe = await meFor(cookiesFrom(callbacks[1]!));
    expect(secondMe).toEqual(firstMe);
    const organizationRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT organization_id, membership_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(pendingUser?.id)
      .all();
    expect(organizationRows.results).toHaveLength(1);
    const ownerRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, role FROM member WHERE userId = ? AND role = 'owner'",
    )
      .bind(pendingUser?.id)
      .all();
    expect(ownerRows.results).toHaveLength(1);
  });

  it("does not revive a deliberately unlinked provider account", async () => {
    const original = {
      id: 814905,
      login: "platform-human-probe-unlink-original",
      name: "Human Probe Unlink Original",
      email: "human-probe-unlink@example.test",
    };
    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER human_probe_fail_account_insert_unlink
       BEFORE INSERT ON account
       WHEN NEW.providerId = 'github' AND NEW.accountId = '814905'
       BEGIN SELECT RAISE(ABORT, 'human recovery unlink setup'); END`,
    ).run();
    try {
      await socialLogin(original, "human-probe-unlink-signin");
    } finally {
      await testEnv.IDENTITY_DB.prepare(
        "DROP TRIGGER human_probe_fail_account_insert_unlink",
      ).run();
    }
    const recovered = await socialLogin(
      original,
      "human-probe-unlink-recovery",
    );
    const recoveredCookie = cookiesFrom(recovered.callback);
    const user = (await pendingRows(original.email))[0];
    expect(user).toBeTruthy();

    const linked = {
      id: 814906,
      login: "platform-human-probe-unlink-second",
      name: "Human Probe Unlink Second",
      email: "human-probe-unlink-second@example.test",
    };
    const linkStart = await startLink(recoveredCookie);
    expect(linkStart.status).toBe(200);
    githubIdentity = linked;
    const linkCallback = await completeSocialCallback(
      linkStart,
      "human-probe-unlink-link-second",
      recoveredCookie,
    );
    expect(linkCallback.status).toBe(302);
    const originalAccount = (await accountRows("814905"))[0];
    expect(originalAccount).toBeTruthy();
    expect(await accountRows("814906")).toHaveLength(1);

    const unlink = await SELF.fetch(
      "http://localhost/api/auth/unlink-account",
      {
        method: "POST",
        headers: {
          cookie: recoveredCookie,
          origin: testEnv.PLATFORM_BASE_URL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: originalAccount!.id }),
      },
    );
    expect(unlink.status).toBe(200);
    expect(await accountRows("814905")).toHaveLength(0);
    expect((await pendingRows(original.email))[0]).toMatchObject({
      id: user?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
    });

    const afterUnlink = await socialLogin(
      original,
      "human-probe-unlink-after-explicit-unlink",
    );
    const afterUnlinkLocation = afterUnlink.callback.headers.get("location");
    expect(afterUnlink.callback.status).toBe(302);
    expect(new URL(afterUnlinkLocation!).searchParams.get("error")).toBe(
      "account_not_linked",
    );
    expect(await accountRows("814905")).toHaveLength(0);
    expect((await pendingRows(original.email))[0]).toMatchObject({
      id: user?.id,
      pendingSocialProviderId: null,
      pendingSocialSubject: null,
    });
  });

  it("coordinates explicit same-provider linking and counts account owners", async () => {
    const first = await loginAs(
      {
        id: 814910,
        login: "platform-human-probe-link-one",
        name: "Human Probe Link One",
        email: "human-probe-link-one@example.test",
      },
      "human-probe-link-one-signin",
    );
    const second = await loginAs(
      {
        id: 814911,
        login: "platform-human-probe-link-two",
        name: "Human Probe Link Two",
        email: "human-probe-link-two@example.test",
      },
      "human-probe-link-two-signin",
    );
    expect((await sessionFor(first.cookie)).user?.id).toBe(first.userId);
    expect((await sessionFor(second.cookie)).user?.id).toBe(second.userId);

    const firstStart = await startLink(first.cookie);
    const secondStart = await startLink(second.cookie);
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);

    githubIdentity = {
      id: 814912,
      login: "platform-human-probe-shared-link",
      name: "Human Probe Shared Link",
      email: "human-probe-shared-link@example.test",
    };
    providerLookupBarrier();
    const [firstCallback, secondCallback] = await Promise.all([
      completeSocialCallback(
        firstStart,
        "human-probe-shared-link-one",
        first.cookie,
      ),
      completeSocialCallback(
        secondStart,
        "human-probe-shared-link-two",
        second.cookie,
      ),
    ]);
    const owners = await accountRows("814912");
    const result = {
      experiment: "concurrent-explicit-link",
      overlap: sharedLookupOverlap,
      providerLookups: sharedLookupCount,
      callbackStatuses: [firstCallback.status, secondCallback.status],
      callbackErrors: [firstCallback, secondCallback].map((response) => {
        const location = response.headers.get("location");
        return location ? new URL(location).searchParams.get("error") : null;
      }),
      owners: owners.map((owner) => owner.userId),
    };
    console.log(JSON.stringify(result));
    if (!sharedLookupOverlap) {
      console.warn(
        "human recovery linking experiment inconclusive: provider lookups did not overlap within 1500ms",
      );
      return;
    }
    expect(owners.length).toBeLessThanOrEqual(1);
    if (owners[0]) {
      expect([first.userId, second.userId]).toContain(owners[0].userId);
    }
    expect((await sessionFor(first.cookie)).user?.id).toBe(first.userId);
    expect((await sessionFor(second.cookie)).user?.id).toBe(second.userId);
  });

  it("uses the provider uniqueness constraint to arbitrate concurrent fresh signups", async () => {
    const identity = {
      id: 814930,
      login: "platform-human-probe-concurrent-signup",
      name: "Human Probe Concurrent Signup",
      email: "human-probe-concurrent-signup@example.test",
    };
    const firstStart = await startSocialLogin();
    const secondStart = await startSocialLogin();
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);

    githubIdentity = identity;
    providerLookupBarrier();
    let callbacks: [Response, Response];
    try {
      callbacks = (await Promise.all([
        completeSocialCallback(firstStart, "human-probe-concurrent-signup-one"),
        completeSocialCallback(
          secondStart,
          "human-probe-concurrent-signup-two",
        ),
      ])) as [Response, Response];
    } finally {
      coordinateSharedLookup = false;
    }

    const users = await userRows(identity.email);
    const owners = await accountRows("814930");
    const result = {
      experiment: "concurrent-fresh-signup",
      overlap: sharedLookupOverlap,
      providerLookups: sharedLookupCount,
      callbackStatuses: callbacks.map((response) => response.status),
      callbackLocations: callbacks.map((response) =>
        response.headers.get("location"),
      ),
      users: users.map((user) => user.id),
      owners: owners.map((owner) => owner.userId),
    };
    console.log(JSON.stringify(result));
    if (!sharedLookupOverlap) {
      console.warn(
        "human recovery fresh signup experiment inconclusive: provider lookups did not overlap within 1500ms",
      );
      return;
    }
    expect(users).toHaveLength(1);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(users[0]?.id);
    const successfulCallback = callbacks.find((response) => {
      const location = response.headers.get("location");
      return location === "http://localhost/account";
    });
    expect(successfulCallback).toBeTruthy();
    const successfulSession = await sessionFor(
      cookiesFrom(successfulCallback!),
    );
    expect(successfulSession.user?.id).toBe(users[0]?.id);

    const firstMe = await meFor(cookiesFrom(successfulCallback!));
    const receipt = await testEnv.IDENTITY_DB.prepare(
      "SELECT organization_id, membership_id FROM platform_default_organization WHERE user_id = ?",
    )
      .bind(users[0]?.id)
      .first<{ organization_id: string; membership_id: string }>();
    expect(receipt).toEqual({
      organization_id: firstMe.organizationId,
      membership_id: firstMe.membershipId,
    });
    const retry = await socialLogin(
      identity,
      "human-probe-concurrent-signup-fresh-retry",
    );
    expect(retry.callback.headers.get("location")).toBe(
      "http://localhost/account",
    );
    const retrySession = await sessionFor(cookiesFrom(retry.callback));
    expect(retrySession.user?.id).toBe(users[0]?.id);
    expect(await meFor(cookiesFrom(retry.callback))).toEqual(firstMe);
    expect(await userRows(identity.email)).toHaveLength(1);
    expect(await accountRows("814930")).toHaveLength(1);
    const ownerRows = await testEnv.IDENTITY_DB.prepare(
      "SELECT id, role FROM member WHERE organizationId = ? AND userId = ? AND role = 'owner'",
    )
      .bind(firstMe.organizationId, users[0]?.id)
      .all();
    expect(ownerRows.results).toHaveLength(1);
  });
});
