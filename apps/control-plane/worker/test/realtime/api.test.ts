import { env as runtimeEnv } from "cloudflare:workers";
import {
  ApiErrorResponseSchema,
  REALTIME_SUBPROTOCOL,
  RealtimeTicketResponseSchema,
  type RealtimeTicketRequest,
} from "@communicator/contracts";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import type { VerifiedSubject } from "../../auth/oidc";
import { digestRealtimeTicket } from "../../realtime/token";
import { clearDirectory, seedAccountAccess, seedDirectory } from "../support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const humanRequest: RealtimeTicketRequest = {
  schema_version: 1,
  subscriptions: [{
    identity_id: "identity_human",
    families: ["projection"],
  }],
};
const agentRequest: RealtimeTicketRequest = {
  schema_version: 1,
  subscriptions: [{
    identity_id: "identity_agent",
    families: ["projection"],
  }],
};

type TestAppOptions = {
  createAccessTokenVerifier?: () => {
    verify(token: string): Promise<VerifiedSubject>;
  };
};

function createTestApp(options: TestAppOptions = {}) {
  return createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return { issuer: "https://issuer.example/", subject: "human-subject" };
        }
        if (token === "agent-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        }
        throw new Error("invalid local test token");
      },
    }),
    ...(options.createAccessTokenVerifier === undefined
      ? {}
      : { createAccessTokenVerifier: options.createAccessTokenVerifier }),
  });
}

function requestEnvironment(
  overrides: Partial<Cloudflare.Env> = {},
): Cloudflare.Env {
  return { ...env, ...overrides } as Cloudflare.Env;
}

async function issueTicket(
  request = humanRequest,
  init: RequestInit = {},
  requestEnv: Cloudflare.Env = requestEnvironment(),
  authorization: string | null = "Bearer human-token",
) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (authorization !== null && !headers.has("Authorization")) {
    headers.set("Authorization", authorization);
  }
  return createTestApp().request(
    "http://example.test/api/v1/realtime/tickets",
    {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify(request),
    },
    requestEnv,
  );
}

async function issuedTicket(
  request = humanRequest,
  url = "http://example.test/api/v1/realtime/tickets",
  headers: HeadersInit = { Authorization: "Bearer human-token" },
) {
  const response = await createTestApp().request(url, {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/json", ...headers }),
    body: JSON.stringify(request),
  }, requestEnvironment());
  expect(response.status).toBe(201);
  return RealtimeTicketResponseSchema.parse(await response.json());
}

type ProjectionCall = {
  tenant: string;
  request: Request;
};

function projectionEnvironment(
  calls: ProjectionCall[],
  response: Response = {
    status: 101,
    headers: new Headers({ "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL }),
  } as Response,
): Cloudflare.Env {
  const namespace = {
    getByName(tenant: string) {
      return {
        fetch: async (request: Request) => {
          calls.push({ tenant, request });
          return response;
        },
      };
    },
  };
  return requestEnvironment({ TENANT_PROJECTION: namespace as never });
}

async function upgrade(
  ticket: string | undefined,
  options: {
    headers?: HeadersInit;
    method?: string;
    query?: string;
    requestEnv?: Cloudflare.Env;
  } = {},
) {
  const search = options.query ?? (ticket === undefined ? "" : `?ticket=${ticket}`);
  const headers = new Headers(options.headers);
  if (!headers.has("Upgrade")) headers.set("Upgrade", "websocket");
  if (!headers.has("Sec-WebSocket-Protocol")) {
    headers.set("Sec-WebSocket-Protocol", REALTIME_SUBPROTOCOL);
  }
  return createTestApp().request(
    `https://example.test/api/v1/realtime${search}`,
    { method: options.method ?? "GET", headers },
    options.requestEnv ?? requestEnvironment(),
  );
}

async function expectApiError(response: Response, status: number) {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(() => JSON.parse(text)).not.toThrow();
  const body = ApiErrorResponseSchema.parse(JSON.parse(text));
  expect(JSON.stringify(body)).toBe(text);
  return { body, text };
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await env.CONTROL_DB.prepare("DELETE FROM realtime_tickets").run();
});

describe("POST /api/v1/realtime/tickets", () => {
  it("issues a strict no-store ticket response with an http websocket URL", async () => {
    const response = await issueTicket();
    expect(response.status).toBe(201);
    const body = RealtimeTicketResponseSchema.parse(await response.json());

    expect(body.websocket_url).toBe(
      `ws://example.test/api/v1/realtime?ticket=${body.ticket}`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(body.websocket_url).not.toContain("sha256");
  });

  it("uses wss for an https request and returns only the shared response shape", async () => {
    const response = await createTestApp().request(
      "https://example.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer human-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(humanRequest),
      },
      requestEnvironment(),
    );
    expect(response.status).toBe(201);
    const body = RealtimeTicketResponseSchema.parse(await response.json());

    expect(body.websocket_url).toBe(
      `wss://example.test/api/v1/realtime?ticket=${body.ticket}`,
    );
    expect(Object.keys(body).sort()).toEqual([
      "expires_at",
      "schema_version",
      "ticket",
      "websocket_url",
    ]);
  });

  it("uses bearer authentication before an Access assertion", async () => {
    const accessVerify = vi.fn(async (): Promise<VerifiedSubject> => ({
      issuer: "https://issuer.example/",
      subject: "human-subject",
    }));
    const response = await createApp({
      createTokenVerifier: () => ({
        verify: async (): Promise<VerifiedSubject> => ({
          issuer: "https://issuer.example/",
          subject: "human-subject",
        }),
      }),
      createAccessTokenVerifier: () => ({ verify: accessVerify }),
    }).request(
      "http://example.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer bearer-wins",
          "Cf-Access-Jwt-Assertion": "access.header.payload",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(humanRequest),
      },
      requestEnvironment(),
    );

    expect(response.status).toBe(201);
    expect(accessVerify).not.toHaveBeenCalled();
    expect(RealtimeTicketResponseSchema.parse(await response.json())).toBeDefined();
  });

  it("issues through the same-origin Access credential when bearer is absent", async () => {
    const accessVerify = vi.fn(async (token: string): Promise<VerifiedSubject> => {
      expect(token).toBe("access.header.payload");
      return { issuer: "https://issuer.example/", subject: "human-subject" };
    });
    const app = createApp({
      createTokenVerifier: () => ({
        verify: async (): Promise<VerifiedSubject> => {
          throw new Error("bearer must not be used");
        },
      }),
      createAccessTokenVerifier: () => ({ verify: accessVerify }),
    });
    const response = await app.request(
      "http://example.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": "access.header.payload",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(humanRequest),
      },
      requestEnvironment(),
    );

    expect(response.status).toBe(201);
    expect(accessVerify).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing bearer", undefined],
    ["invalid bearer", "Bearer invalid-token"],
  ])("returns one bounded 401 for %s", async (_name, authorization) => {
    const response = await issueTicket(
      humanRequest,
      authorization === undefined ? {} : { headers: { Authorization: authorization } },
      requestEnvironment(),
      authorization ?? null,
    );
    const failure = await expectApiError(response, 401);
    expect(failure.body).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("returns the same 404 for an unknown identity and a missing conversation scope", async () => {
    const unknown = await issueTicket({
      schema_version: 1,
      subscriptions: [{ identity_id: "identity_agent", families: ["projection"] }],
    });
    const unknownFailure = await expectApiError(unknown, 404);

    await env.CONTROL_DB.prepare(
      "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND operation_scope = ?",
    ).bind("tenant_pilot", "membership_human", "identity_human", "conversation.read").run();
    const missingScope = await issueTicket();
    const missingScopeFailure = await expectApiError(missingScope, 404);

    expect(missingScopeFailure.text).toBe(unknownFailure.text);
    expect(missingScopeFailure.body).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it.each([
    ["duplicate subscription", {
      schema_version: 1,
      subscriptions: [
        { identity_id: "identity_human", families: ["projection"] },
        { identity_id: "identity_human", families: ["projection"] },
      ],
    }],
    ["extra key", { ...humanRequest, unexpected: true }],
  ])("rejects %s with the bounded invalid-request body", async (_name, request) => {
    const response = await issueTicket(request as RealtimeTicketRequest);
    const failure = await expectApiError(response, 400);
    expect(failure.body).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("rejects malformed JSON with the same invalid-request body", async () => {
    const response = await createTestApp().request(
      "http://example.test/api/v1/realtime/tickets",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer human-token",
          "Content-Type": "application/json",
        },
        body: "{malformed",
      },
      requestEnvironment(),
    );
    const failure = await expectApiError(response, 400);
    expect(failure.body).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it.each([
    ["a SyntaxError", new SyntaxError("unexpected ticket detail"), "Internal Server Error"],
    [
      "an unrelated HTTP 400",
      new HTTPException(400, { message: "unrelated ticket detail" }),
      "unrelated ticket detail",
    ],
  ])("does not map %s to invalid_request", async (_name, error, expectedText) => {
    const errorHandler = (createTestApp() as unknown as {
      errorHandler: (
        error: Error,
        context: {
          req: { path: string };
          json(body: unknown, status: number): Response;
          text(body: string, status: number): Response;
          newResponse(body: BodyInit | null, init?: ResponseInit): Response;
        },
      ) => Response | Promise<Response>;
    }).errorHandler;

    const response = await errorHandler(error, {
      req: { path: "/api/v1/realtime/tickets" },
      json: (body, status) => new Response(JSON.stringify(body), { status }),
      text: (body, status) => new Response(body, { status }),
      newResponse: (body, init) => new Response(body, init),
    });

    expect(response.status).toBe(error instanceof SyntaxError ? 500 : 400);
    expect(await response.text()).toBe(expectedText);
  });

  it("maps only Hono's exact malformed JSON exception to invalid_request", async () => {
    const errorHandler = (createTestApp() as unknown as {
      errorHandler: (
        error: Error,
        context: {
          req: { path: string };
          json(body: unknown, status: number): Response;
          text(body: string, status: number): Response;
        },
      ) => Response | Promise<Response>;
    }).errorHandler;

    const response = await errorHandler(
      new HTTPException(400, { message: "Malformed JSON in request body" }),
      {
        req: { path: "/api/v1/realtime/tickets" },
        json: (body, status) => new Response(JSON.stringify(body), { status }),
        text: (body, status) => new Response(body, { status }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("keeps unexpected ticket implementation failures on the normal 500 path", async () => {
    const secret = "unexpected-ticket-implementation-detail";
    const errorHandler = (createTestApp() as unknown as {
      errorHandler: (
        error: Error,
        context: {
          req: { path: string };
          json(body: unknown, status: number): Response;
          text(body: string, status: number): Response;
        },
      ) => Response | Promise<Response>;
    }).errorHandler;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await errorHandler(new Error(secret), {
        req: { path: "/api/v1/realtime/tickets" },
        json: (body, status) => new Response(JSON.stringify(body), { status }),
        text: (body, status) => new Response(body, { status }),
      });

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toBe("Internal Server Error");
      expect(text).not.toContain(secret);
      const loggedArguments = log.mock.calls
        .flatMap((argumentsList) => argumentsList.map((argument) => String(argument)))
        .join("\n");
      expect(loggedArguments).not.toContain(secret);
      expect(log.mock.calls).toEqual([[{ event: "internal_server_error" }]]);
    } finally {
      log.mockRestore();
    }
  });

  it("maps D1 authorization failure to a bounded 503 without echoing details", async () => {
    const secret = "d1-secret-ticket-detail";
    const failingDb = {
      withSession() {
        throw new Error(secret);
      },
    } as unknown as D1Database;
    const response = await issueTicket(humanRequest, {}, requestEnvironment({ CONTROL_DB: failingDb }));
    const failure = await expectApiError(response, 503);

    expect(failure.body).toEqual({
      error: { code: "service_unavailable", message: "Authorization service unavailable" },
    });
    expect(failure.text).not.toContain(secret);
  });
});

describe("GET /api/v1/realtime", () => {
  it.each(["POST", "PUT"])(
    "does not route %s to the upgrade handler or consume a ticket",
    async (method) => {
      const issued = await issuedTicket();
      const calls: ProjectionCall[] = [];
      const response = await upgrade(issued.ticket, {
        method,
        requestEnv: projectionEnvironment(calls),
      });

      expect(response.status).toBe(404);
      expect(calls).toHaveLength(0);

      const valid = await upgrade(issued.ticket, {
        requestEnv: projectionEnvironment(calls),
      });
      expect(valid.status).toBe(101);
      expect(calls).toHaveLength(1);
    },
  );

  it("consumes one ticket, selects its tenant, and forwards only the internal upgrade request", async () => {
    const issued = await issuedTicket();
    const calls: ProjectionCall[] = [];
    const headers = new Headers({
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
      Authorization: "Bearer caller-token-must-not-forward",
      "Cf-Access-Jwt-Assertion": "access.secret.must-not-forward",
      Cookie: "session=secret",
      "X-Communicator-Tenant": "tenant-attacker-choice",
      "X-Internal-Realtime-Context": "caller-context-must-not-forward",
    });
    const response = await upgrade(issued.ticket, {
      headers,
      requestEnv: projectionEnvironment(calls),
    });

    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(REALTIME_SUBPROTOCOL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenant).toBe("tenant_pilot");
    expect(calls[0]?.request.url).toBe("https://tenant-projection.internal/realtime");
    expect([...calls[0]!.request.headers.entries()].sort()).toEqual([
      ["connection", "Upgrade"],
      ["sec-websocket-protocol", REALTIME_SUBPROTOCOL],
      ["upgrade", "websocket"],
      ["x-communicator-realtime-context", expect.any(String)],
    ]);
    const internalContext = JSON.parse(
      calls[0]!.request.headers.get("X-Communicator-Realtime-Context") ?? "null",
    ) as Record<string, unknown>;
    expect(internalContext).toMatchObject({
      schema_version: 1,
      tenant_id: "tenant_pilot",
      principal_id: "principal_human",
      membership_id: "membership_human",
      subscriptions: humanRequest.subscriptions,
      resume: [],
    });
    expect(calls[0]!.request.url).not.toContain(issued.ticket);
    expect(JSON.stringify(internalContext)).not.toContain("caller-token");
    expect(JSON.stringify(internalContext)).not.toContain("access.secret");
    expect(JSON.stringify(internalContext)).not.toContain("tenant-attacker-choice");
  });

  it.each([
    ["non-upgrade", { Upgrade: "not-websocket" }, ""],
    ["wrong subprotocol", {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": "communicator.realtime.v0",
    }, ""],
    ["duplicate ticket", {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
    }, "?ticket=rt1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&ticket=rt1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ["extra query key", {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
    }, "?ticket=rt1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&tenant=tenant_pilot"],
  ])("rejects %s before D1 with bounded 400", async (_name, headers, query) => {
    const database = {
      withSession() {
        throw new Error("D1 must not be touched");
      },
    } as unknown as D1Database;
    const response = await upgrade("rt1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      headers,
      query,
      requestEnv: requestEnvironment({ CONTROL_DB: database }),
    });
    const failure = await expectApiError(response, 400);
    expect(failure.body).toEqual({
      error: { code: "invalid_request", message: "Invalid request" },
    });
  });

  it("returns one byte-identical 401 for missing, expired, and reused tickets", async () => {
    const missing = await upgrade(undefined);
    const missingFailure = await expectApiError(missing, 401);

    const expired = await issuedTicket();
    await env.CONTROL_DB.prepare(
      "UPDATE realtime_tickets SET expires_at_ms = ?, expires_at = ? WHERE ticket_digest = ?",
    ).bind(
      0,
      "2020-01-01T00:00:00.000Z",
      await digestRealtimeTicket(expired.ticket),
    ).run();
    const expiredFailure = await expectApiError(await upgrade(expired.ticket), 401);

    const reusable = await issuedTicket();
    const calls: ProjectionCall[] = [];
    await expect((await upgrade(reusable.ticket, { requestEnv: projectionEnvironment(calls) })).status).toBe(101);
    const reusedFailure = await expectApiError(await upgrade(reusable.ticket), 401);

    expect(expiredFailure.text).toBe(missingFailure.text);
    expect(reusedFailure.text).toBe(missingFailure.text);
    expect(calls).toHaveLength(1);
  });

  it("maps D1 and Durable Object failures to bounded 503 responses", async () => {
    const issued = await issuedTicket();
    const digest = issued.ticket;
    const failingDb = {
      withSession() {
        throw new Error(`database failure ${digest}`);
      },
    } as unknown as D1Database;
    const d1Failure = await upgrade(issued.ticket, {
      requestEnv: requestEnvironment({ CONTROL_DB: failingDb }),
    });
    const d1Error = await expectApiError(d1Failure, 503);
    expect(d1Error.text).not.toContain(digest);

    const doFailureTicket = await issuedTicket();
    const namespace = {
      getByName() {
        throw new Error(`DO failure ${digest}`);
      },
    };
    const doFailure = await upgrade(doFailureTicket.ticket, {
      requestEnv: requestEnvironment({ TENANT_PROJECTION: namespace as never }),
    });
    const doError = await expectApiError(doFailure, 503);
    expect(doError.text).not.toContain(digest);
  });

  it("keeps tenant-admin realtime and denies delegated agent realtime", async () => {
    const human = await issuedTicket(humanRequest, "http://example.test/api/v1/realtime/tickets", {
      Authorization: "Bearer human-token",
    });
    const agent = await issueTicket(agentRequest, {}, requestEnvironment(), "Bearer agent-token");
    await expectApiError(agent, 404);
    const calls: ProjectionCall[] = [];
    await upgrade(human.ticket, { requestEnv: projectionEnvironment(calls) });

    expect(calls).toHaveLength(1);
    const humanContext = JSON.parse(
      calls[0]!.request.headers.get("X-Communicator-Realtime-Context") ?? "null",
    ) as Record<string, unknown>;
    expect(humanContext).toMatchObject({
      principal_id: "principal_human",
      subscriptions: humanRequest.subscriptions,
    });
    expect(JSON.stringify(humanContext)).not.toContain("identity_agent");
  });

  it("does not infer delegated realtime access from empty or retired account rows", async () => {
    const emptyRegistry = await issueTicket(agentRequest, {}, requestEnvironment(), "Bearer agent-token");
    await expectApiError(emptyRegistry, 404);

    await seedAccountAccess(env.CONTROL_DB);
    await env.CONTROL_DB.prepare(
      "UPDATE connection_accounts SET status = 'retired', retired_at = ? WHERE account_id = ?",
    ).bind("2026-09-07T04:00:00.000Z", "account_agent").run();
    const retiredRegistry = await issueTicket(agentRequest, {}, requestEnvironment(), "Bearer agent-token");
    await expectApiError(retiredRegistry, 404);

    const tenantAdmin = await issueTicket(humanRequest);
    expect(tenantAdmin.status).toBe(201);
  });

  it("does not attach product authorization middleware to the upgrade path", async () => {
    const issued = await issuedTicket();
    const calls: ProjectionCall[] = [];
    const response = await upgrade(issued.ticket, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
        Authorization: "Bearer invalid-token",
        "Cf-Access-Jwt-Assertion": "not-a-valid-access-token",
      },
      requestEnv: projectionEnvironment(calls),
    });

    expect(response.status).toBe(101);
    expect(calls).toHaveLength(1);
  });

  it("does not consume a ticket when protocol validation fails", async () => {
    const issued = await issuedTicket();
    const invalid = await upgrade(issued.ticket, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "wrong",
      },
    });
    await expectApiError(invalid, 400);

    const calls: ProjectionCall[] = [];
    const valid = await upgrade(issued.ticket, {
      requestEnv: projectionEnvironment(calls),
    });
    expect(valid.status).toBe(101);
    expect(calls).toHaveLength(1);
  });

  it("never logs ticket or digest material while returning failures", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const issued = await issuedTicket();
      const failure = await upgrade(issued.ticket, {
        headers: {
          Upgrade: "not-websocket",
          "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL,
        },
      });
      const result = await expectApiError(failure, 400);
      expect(result.text).not.toContain(issued.ticket);
      expect(JSON.stringify(log.mock.calls)).not.toContain(issued.ticket);
    } finally {
      log.mockRestore();
    }
  });
});
