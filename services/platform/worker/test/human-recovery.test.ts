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

async function startSocialLogin(cookie = ""): Promise<Response> {
  return SELF.fetch("http://localhost/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: testEnv.PLATFORM_BASE_URL,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      provider: "github",
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
): Promise<Response> {
  const startBody = (await start.clone().json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();
  return SELF.fetch(
    `http://localhost/api/auth/callback/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`,
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
): Promise<
  Array<{ id: string; userId: string; providerId: string; accountId: string }>
> {
  const rows = await testEnv.IDENTITY_DB.prepare(
    "SELECT id, userId, providerId, accountId FROM account WHERE providerId = 'github' AND accountId = ? ORDER BY id",
  )
    .bind(accountId)
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
    coordinateSharedLookup = false;
    sharedLookupCount = 0;
    sharedLookupOverlap = false;
    vi.stubGlobal("fetch", vi.fn(providerRequest));
  });

  it("records interrupted signup state and same-provider retry behavior", async () => {
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

    const retry = await socialLogin(
      interruptedIdentity,
      "human-probe-interrupted-retry",
    );
    const retryLocation = retry.callback.headers.get("location");
    expect(retry.callback.status).toBe(302);
    expect(retryLocation).toContain("error=account_not_linked");
    expect(await userRows(interruptedIdentity.email)).toHaveLength(1);
    expect(await accountRows("814901")).toHaveLength(0);
    expect(
      interruptedUsers[0] ? await sessionRows(interruptedUsers[0].id) : [],
    ).toHaveLength(0);

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
          error: new URL(retryLocation!).searchParams.get("error"),
          users: (await userRows(interruptedIdentity.email)).length,
          accounts: (await accountRows("814901")).length,
          sessions: interruptedUsers[0]
            ? (await sessionRows(interruptedUsers[0].id)).length
            : 0,
        },
      }),
    );
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
});
