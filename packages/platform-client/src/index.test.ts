import { describe, expect, it, mock } from "bun:test";
import {
  createPlatformBrowserClient,
  createPlatformClient,
  createPlatformGuestClient,
  isSameOriginUnsafeBrowserRequest,
  selectBrowserCredential,
  type BrowserOAuthTransaction,
  type BrowserOAuthTransactionStore,
} from "./index";

const now = Date.now();
const validPrincipal = {
  version: 1,
  kind: "human",
  authority: "platform-deployment",
  subjectId: "user-1",
  credentialId: "credential-1",
  audience: "https://service.0000.test",
  capabilities: ["resource:read"],
  expiresAt: new Date(now + 60_000).toISOString(),
  organizationId: "org-1",
  membershipId: "member-1",
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function client(fetch: typeof globalThis.fetch) {
  return createPlatformClient({
    baseUrl: "https://platform.test",
    authority: "platform-deployment",
    audience: "https://service.0000.test",
    serviceVerifier: "service-verifier-only",
    fetch,
  });
}

describe("Platform verification client", () => {
  it("sends the presented credential separately from the verifier and accepts a valid principal", async () => {
    let call: { url: URL; init: RequestInit } | undefined;
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: new URL(String(input)), init: init ?? {} };
      return Response.json({
        status: "authenticated",
        principal: validPrincipal,
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await client(fetch).authenticate("end-user-credential");
    expect(result.status).toBe("authenticated");
    expect(call?.url.pathname).toBe("/internal/v1/authenticate");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      "Bearer service-verifier-only",
    );
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      credential: "end-user-credential",
    });
  });

  it("treats a wrong authority or malformed success response as an authority failure", async () => {
    const wrongAuthority = client(async () =>
      Response.json({
        status: "authenticated",
        principal: { ...validPrincipal, authority: "other-deployment" },
      }),
    ).authenticate("end-user-credential");
    const wrongAudience = client(async () =>
      Response.json({
        status: "authenticated",
        principal: {
          ...validPrincipal,
          audience: "https://other-service.test",
        },
      }),
    ).authenticate("end-user-credential");
    const expired = client(async () =>
      Response.json({
        status: "authenticated",
        principal: {
          ...validPrincipal,
          expiresAt: new Date(now - 1).toISOString(),
        },
      }),
    ).authenticate("end-user-credential");
    const malformed = client(async () =>
      Response.json({ status: "authenticated", principal: null }),
    ).authenticate("end-user-credential");
    const unknownStatus = client(async () =>
      Response.json({ status: "accepted", principal: validPrincipal }),
    ).authenticate("end-user-credential");
    const malformedJson = client(
      async () => new Response("not-json", { status: 200 }),
    ).authenticate("end-user-credential");
    const inconsistentHttpStatus = client(async () =>
      Response.json({ status: "invalid_credential" }, { status: 200 }),
    ).authenticate("end-user-credential");

    expect((await wrongAuthority).status).toBe("authority_unavailable");
    expect((await wrongAudience).status).toBe("authority_unavailable");
    expect((await expired).status).toBe("authority_unavailable");
    expect((await malformed).status).toBe("authority_unavailable");
    expect((await unknownStatus).status).toBe("authority_unavailable");
    expect((await malformedJson).status).toBe("authority_unavailable");
    expect((await inconsistentHttpStatus).status).toBe("authority_unavailable");
  });

  it("returns invalid only for a rejected presented credential, and fails closed on outage", async () => {
    let calls = 0;
    const rejected = await client(async () => {
      calls += 1;
      return Response.json({ status: "invalid_credential" }, { status: 401 });
    }).authenticate("end-user-credential");
    expect(rejected.status).toBe("invalid_credential");
    expect(calls).toBe(1);

    const verifierRejected = await client(async () =>
      Response.json({ error: "service verifier rejected" }, { status: 401 }),
    ).authenticate("end-user-credential");
    const wrongCategory = await client(async () =>
      Response.json({ status: "authority_unavailable" }, { status: 401 }),
    ).authenticate("end-user-credential");
    expect(verifierRejected.status).toBe("authority_unavailable");
    expect(wrongCategory.status).toBe("authority_unavailable");

    const outage = await client(async () => {
      throw new Error("offline");
    }).authenticate("end-user-credential");
    expect(outage.status).toBe("authority_unavailable");
  });

  it("maps a malformed base URL to authority_unavailable", async () => {
    const fetch = mock(async () => {
      throw new Error("the malformed endpoint must not be fetched");
    }) as unknown as typeof globalThis.fetch;

    const authenticated = await createPlatformClient({
      baseUrl: "not a URL",
      authority: "platform-deployment",
      audience: "https://service.0000.test",
      serviceVerifier: "service-verifier-only",
      fetch,
    }).authenticate("end-user-credential");
    const guest = await createPlatformGuestClient({
      baseUrl: "not a URL",
      authority: "platform-deployment",
      audience: "https://service.0000.test",
      guestGrantIssuer: "guest-issuer-only",
      fetch,
    }).createGuest();

    expect(authenticated).toEqual({ status: "authority_unavailable" });
    expect(guest).toEqual({ status: "authority_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("expires a delayed fetch and aborts it without accepting its late success", async () => {
    let resolveFetch!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof globalThis.fetch;

    const resultPromise = createPlatformClient({
      baseUrl: "https://platform.test",
      authority: "platform-deployment",
      audience: "https://service.0000.test",
      serviceVerifier: "service-verifier-only",
      fetch,
      timeoutMs: 10,
    }).authenticate("end-user-credential");
    const result = await resultPromise;

    expect(result).toEqual({ status: "authority_unavailable" });
    expect(signal?.aborted).toBe(true);

    resolveFetch(
      Response.json({ status: "authenticated", principal: validPrincipal }),
    );
    await wait(20);
    expect(result).toEqual({ status: "authority_unavailable" });
  });

  it("expires a delayed response body under the same fetch deadline", async () => {
    let resolveBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    const response = {
      status: 200,
      ok: true,
      redirected: false,
      url: "",
      json: () => body,
    } as unknown as Response;

    const result = await createPlatformClient({
      baseUrl: "https://platform.test",
      authority: "platform-deployment",
      audience: "https://service.0000.test",
      serviceVerifier: "service-verifier-only",
      fetch: async () => response,
      timeoutMs: 10,
    }).authenticate("end-user-credential");

    expect(result).toEqual({ status: "authority_unavailable" });
    resolveBody({ status: "authenticated", principal: validPrincipal });
    await wait(20);
    expect(result).toEqual({ status: "authority_unavailable" });
  });

  it("observes a late rejected fetch after timeout without changing the result", async () => {
    let rejectFetch!: (reason: unknown) => void;
    const fetch = mock(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
    ) as unknown as typeof globalThis.fetch;

    const result = await createPlatformClient({
      baseUrl: "https://platform.test",
      authority: "platform-deployment",
      audience: "https://service.0000.test",
      serviceVerifier: "service-verifier-only",
      fetch,
      timeoutMs: 10,
    }).authenticate("end-user-credential");
    expect(result).toEqual({ status: "authority_unavailable" });

    rejectFetch(new Error("late transport failure"));
    await wait(20);
    expect(result).toEqual({ status: "authority_unavailable" });
  });

  it("rejects invalid timeout configuration at client construction", () => {
    for (const timeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      60_001,
    ]) {
      expect(() =>
        createPlatformClient({
          baseUrl: "https://platform.test",
          authority: "platform-deployment",
          audience: "https://service.0000.test",
          serviceVerifier: "service-verifier-only",
          timeoutMs,
        }),
      ).toThrow(RangeError);
      expect(() =>
        createPlatformGuestClient({
          baseUrl: "https://platform.test",
          authority: "platform-deployment",
          audience: "https://service.0000.test",
          guestGrantIssuer: "guest-issuer-only",
          timeoutMs,
        }),
      ).toThrow(RangeError);
    }

    expect(
      createPlatformClient({
        baseUrl: "https://platform.test",
        authority: "platform-deployment",
        audience: "https://service.0000.test",
        serviceVerifier: "service-verifier-only",
        timeoutMs: 1,
      }),
    ).toBeDefined();
    expect(
      createPlatformGuestClient({
        baseUrl: "https://platform.test",
        authority: "platform-deployment",
        audience: "https://service.0000.test",
        guestGrantIssuer: "guest-issuer-only",
        timeoutMs: 60_000,
      }),
    ).toBeDefined();
  });
});

class MemoryBrowserTransactionStore implements BrowserOAuthTransactionStore {
  private readonly rows = new Map<string, BrowserOAuthTransaction>();

  async put(transaction: BrowserOAuthTransaction): Promise<void> {
    this.rows.set(transaction.stateHash, transaction);
  }

  async consume(input: {
    stateHash: string;
    browserBindingHash: string;
    now: number;
  }): Promise<BrowserOAuthTransaction | null> {
    const row = this.rows.get(input.stateHash);
    if (
      !row ||
      row.browserBindingHash !== input.browserBindingHash ||
      row.expiresAt <= input.now
    ) {
      return null;
    }
    this.rows.delete(input.stateHash);
    return row;
  }

  async cleanup(input: { now: number; limit: number }): Promise<number> {
    let removed = 0;
    for (const [stateHash, row] of this.rows) {
      if (removed >= input.limit) break;
      if (row.expiresAt <= input.now) {
        this.rows.delete(stateHash);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.rows.size;
  }
}

function cookiePair(header: string): string {
  return header.split(";", 1)[0]!;
}

function browserOptions(
  store: BrowserOAuthTransactionStore,
  fetch: typeof globalThis.fetch,
  now: () => number,
) {
  return {
    baseUrl: "https://platform.test",
    authority: "platform-deployment",
    audience: "https://service.0000.test",
    serviceVerifier: "service-verifier-only",
    clientId: "first-party-client",
    clientSecret: "client-secret-only-on-server",
    redirectUri: "https://browser.test/oauth/callback",
    resource: "https://service.0000.test",
    scopes: ["resource:read"],
    returnOrigin: "https://browser.test",
    transactionStore: store,
    fetch,
    now,
    timeoutMs: 25,
  };
}

describe("Platform browser OAuth client", () => {
  it("binds PKCE and browser state, verifies a human token, and issues only a host cookie", async () => {
    const store = new MemoryBrowserTransactionStore();
    const clock = Date.now();
    const calls: Array<{ path: string; body: string; authorization: string | null }> = [];
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        body: String(init?.body ?? ""),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/token")) {
        return Response.json({
          access_token: "opaque-human-access",
          token_type: "Bearer",
          expires_in: 60,
        });
      }
      return Response.json({ status: "authenticated", principal: validPrincipal });
    }) as unknown as typeof globalThis.fetch;
    const client = createPlatformBrowserClient(
      browserOptions(store, fetch, () => clock),
    );
    const started = await client.start({ returnTo: "/settings?tab=security" });
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("client_id")).toBe("first-party-client");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://browser.test/oauth/callback",
    );
    expect(authorization.searchParams.get("resource")).toBe(
      "https://service.0000.test",
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("state")).toBeTruthy();
    expect(authorization.searchParams.get("code")).toBeNull();

    const callback = await client.callback(
      new Request(
        `https://browser.test/oauth/callback?${new URLSearchParams({
          code: "authorization-code",
          state: authorization.searchParams.get("state")!,
        })}`,
        { headers: { cookie: cookiePair(started.setCookie) } },
      ),
    );
    expect(callback.status).toBe("authenticated");
    if (callback.status === "authenticated") {
      expect(callback.returnTo).toBe("/settings?tab=security");
      expect(callback).not.toHaveProperty("credential");
      expect(callback.setCookie).toContain("Secure");
      expect(callback.setCookie).toContain("HttpOnly");
      expect(callback.setCookie).toContain("SameSite=Lax");
      expect(callback.setCookie).not.toContain("Domain=");
      expect(callback.clearBrowserBindingCookie).toContain("Max-Age=0");
    }
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/oauth2/token",
      "/internal/v1/authenticate",
    ]);
    expect(calls[0]?.body).toContain("client_secret=client-secret-only-on-server");
    expect(calls[1]?.authorization).toBe("Bearer service-verifier-only");
  });

  it("preserves a transaction for the wrong browser and lets only one concurrent callback win", async () => {
    const store = new MemoryBrowserTransactionStore();
    const nowValue = Date.now();
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/token")
        ? Response.json({
            access_token: "opaque-human-access",
            token_type: "Bearer",
            expires_in: 60,
          })
        : Response.json({ status: "authenticated", principal: validPrincipal });
    };
    const client = createPlatformBrowserClient(
      browserOptions(store, fetch, () => nowValue),
    );
    const started = await client.start();
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const url = new URL(started.authorizationUrl);
    const callbackUrl = `https://browser.test/oauth/callback?code=code&state=${encodeURIComponent(url.searchParams.get("state")!)}`;
    const wrongBrowser = await client.callback(
      new Request(callbackUrl, { headers: { cookie: "__Host-0000-oauth-binding=wrong" } }),
    );
    expect(wrongBrowser).toMatchObject({ status: "invalid_login", reason: "invalid_state" });
    expect(store.size()).toBe(1);
    const results = await Promise.all([
      client.callback(new Request(callbackUrl, { headers: { cookie: cookiePair(started.setCookie) } })),
      client.callback(new Request(callbackUrl, { headers: { cookie: cookiePair(started.setCookie) } })),
    ]);
    expect(results.filter((result) => result.status === "authenticated")).toHaveLength(1);
    expect(results.filter((result) => result.status === "invalid_login")).toHaveLength(1);
    expect(store.size()).toBe(0);
  });

  it("distinguishes expired and unavailable callbacks, bounds cleanup, and gives Authorization precedence", async () => {
    const store = new MemoryBrowserTransactionStore();
    let clock = Date.now();
    const hangingFetch = mock(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof globalThis.fetch;
    const client = createPlatformBrowserClient(
      browserOptions(store, hangingFetch, () => clock),
    );
    const started = await client.start();
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const url = new URL(started.authorizationUrl);
    clock += 301_000;
    const expired = await client.callback(
      new Request(
        `https://browser.test/oauth/callback?code=code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
        { headers: { cookie: cookiePair(started.setCookie) } },
      ),
    );
    expect(expired).toMatchObject({ status: "invalid_login", reason: "invalid_state" });

    const unavailableStore = new MemoryBrowserTransactionStore();
    let current = Date.now();
    const unavailableClient = createPlatformBrowserClient(
      browserOptions(unavailableStore, hangingFetch, () => current),
    );
    const unavailableStart = await unavailableClient.start();
    expect(unavailableStart.status).toBe("started");
    if (unavailableStart.status !== "started") return;
    const unavailableUrl = new URL(unavailableStart.authorizationUrl);
    const unavailable = await unavailableClient.callback(
      new Request(
        `https://browser.test/oauth/callback?code=code&state=${encodeURIComponent(unavailableUrl.searchParams.get("state")!)}`,
        { headers: { cookie: cookiePair(unavailableStart.setCookie) } },
      ),
    );
    expect(unavailable.status).toBe("authority_unavailable");

    const cookieRequest = new Request("https://browser.test/resource", {
      headers: {
        authorization: "Basic malformed",
        cookie: "__Host-0000-access=valid-cookie",
      },
    });
    expect(selectBrowserCredential(cookieRequest)).toEqual({
      source: "authorization",
      status: "invalid",
      credential: null,
    });
    expect(
      isSameOriginUnsafeBrowserRequest(
        new Request("https://browser.test/mutate", {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        }),
        "https://browser.test",
      ),
    ).toBe(false);
    expect(
      isSameOriginUnsafeBrowserRequest(
        new Request("https://browser.test/mutate", {
          method: "POST",
          headers: { origin: "https://browser.test" },
        }),
        "https://browser.test",
      ),
    ).toBe(true);
    expect(
      isSameOriginUnsafeBrowserRequest(
        new Request("https://browser.test/read", { method: "GET" }),
        "https://browser.test",
      ),
    ).toBe(true);
  });
});

describe("Platform guest control client", () => {
  const guestOptions = {
    baseUrl: "https://platform.test",
    authority: "platform-deployment",
    audience: "https://service.0000.test",
    guestGrantIssuer: "guest-issuer-only",
  };
  const guestPrincipal = {
    version: 1,
    kind: "guest",
    authority: "platform-deployment",
    subjectId: "guest-1",
    credentialId: "credential-1",
    audience: "https://service.0000.test",
    capabilities: ["resource:read"],
    expiresAt: null,
    grantId: "grant-1",
    resourceIds: ["resource-1"],
  };

  it("uses the issuer-only transport and validates a grant success", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname === "/internal/v1/guests") {
        return Response.json(
          {
            status: "success",
            guestId: "guest-1",
            bootstrapCredential: "bootstrap-1",
            authority: "platform-deployment",
            audience: "https://service.0000.test",
            purpose: "guest_control",
          },
          { status: 201 },
        );
      }
      return Response.json(
        {
          status: "success",
          credential: "grant-secret",
          credentialId: "credential-1",
          grantId: "grant-1",
          principal: guestPrincipal,
        },
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = createPlatformGuestClient({ ...guestOptions, fetch });
    const created = await client.createGuest();
    const grant = await client.attestGuestGrant({
      bootstrapCredential: "bootstrap-1",
      resourceId: "resource-1",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: "guest-1" },
    });
    expect(created.status).toBe("success");
    expect(grant.status).toBe("success");
    expect(
      calls.every((call) => call.authorization === "Bearer guest-issuer-only"),
    ).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      "/internal/v1/guests",
      "/internal/v1/guest-grants",
    ]);
  });

  it("retains resolve, renew and revoke guest operations", async () => {
    const calls: string[] = [];
    const fetch = mock(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/internal/v1/guests/resolve") {
        return Response.json({
          status: "success",
          guestId: "guest-1",
          authority: guestOptions.authority,
          audience: guestOptions.audience,
          purpose: "guest_control",
        });
      }
      if (url.pathname.endsWith("/renew")) {
        return Response.json({
          status: "success",
          credential: "renewed-grant-secret",
          credentialId: "credential-1",
          grantId: "grant-1",
          principal: guestPrincipal,
        });
      }
      return Response.json({ status: "success", revoked: true });
    }) as unknown as typeof globalThis.fetch;
    const client = createPlatformGuestClient({ ...guestOptions, fetch });

    expect((await client.resolveGuestControl("bootstrap-1")).status).toBe(
      "success",
    );
    expect(
      (
        await client.renewGuestGrant({
          grantId: "grant-1",
          bootstrapCredential: "bootstrap-1",
          resourceId: "resource-1",
          capabilities: ["resource:read"],
          assertion: { kind: "owner", storedOwnerId: "guest-1" },
        })
      ).status,
    ).toBe("success");
    expect(await client.revokeGuestGrant("grant-1")).toEqual({
      status: "success",
      revoked: true,
    });
    expect(calls).toEqual([
      "/internal/v1/guests/resolve",
      "/internal/v1/guest-grants/grant-1/renew",
      "/internal/v1/guest-grants/grant-1/revoke",
    ]);
  });

  it("preserves denial categories and fails closed on malformed or mismatched responses", async () => {
    const result = async (response: Response) =>
      createPlatformGuestClient({
        ...guestOptions,
        fetch: async () => response,
      }).resolveGuestControl("bootstrap-1");
    expect(
      (
        await result(
          Response.json({ status: "invalid_guest_control" }, { status: 401 }),
        )
      ).status,
    ).toBe("invalid_guest_control");
    expect(
      (await result(Response.json({ status: "grant_denied" }, { status: 403 })))
        .status,
    ).toBe("grant_denied");
    expect(
      (
        await result(
          Response.json({ status: "invalid_guest_control" }, { status: 200 }),
        )
      ).status,
    ).toBe("authority_unavailable");
    expect(
      (
        await result(
          Response.json({
            status: "success",
            guestId: "g",
            authority: "wrong",
            audience: guestOptions.audience,
            purpose: "guest_control",
          }),
        )
      ).status,
    ).toBe("authority_unavailable");
    expect(
      (await result(new Response("not-json", { status: 200 }))).status,
    ).toBe("authority_unavailable");
  });

  it("fails closed on actual redirects without sending credentials or guest control to the target", async () => {
    let targetRequests = 0;
    let targetAuthorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request: Request) {
        const url = new URL(request.url);
        if (url.pathname === "/capture") {
          targetRequests += 1;
          targetAuthorization = request.headers.get("authorization");
          return new Response("captured");
        }
        return Response.redirect(`${url.origin}/capture`, 302);
      },
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const authenticated = await createPlatformClient({
        baseUrl,
        authority: "platform-deployment",
        audience: "https://service.0000.test",
        serviceVerifier: "service-verifier-only",
      }).authenticate("end-user-credential");
      const guestClient = createPlatformGuestClient({
        ...guestOptions,
        baseUrl,
      });
      const guest = await guestClient.createGuest();
      const resolvedGuest = await guestClient.resolveGuestControl(
        "bootstrap-secret",
      );

      expect(authenticated).toEqual({ status: "authority_unavailable" });
      expect(guest).toEqual({ status: "authority_unavailable" });
      expect(resolvedGuest).toEqual({ status: "authority_unavailable" });
      expect(targetRequests).toBe(0);
      expect(targetAuthorization).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
