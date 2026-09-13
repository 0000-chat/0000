import { env as runtimeEnv } from "cloudflare:workers";
import {
  ApiErrorResponseSchema,
  SessionResponseSchema,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { MAX_AUTH_TOKEN_CHARS } from "../auth/bearer";
import type { VerifiedSubject } from "../auth/oidc";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };

type TestAppOptions = {
  createAccessTokenVerifier?: (env: Cloudflare.Env) => {
    verify(token: string): Promise<VerifiedSubject>;
  };
};

function createTestApp(options: TestAppOptions = {}) {
  return createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
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

async function sessionRequest(authHeader?: string, tenant?: string) {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("Authorization", authHeader);
  if (tenant !== undefined) headers.set("X-Communicator-Tenant", tenant);
  return createTestApp().request(
    "http://example.test/api/v1/session",
    { headers },
    env,
  );
}

async function sessionRequestWithHeaders(
  headers: Headers,
  app = createTestApp(),
  requestEnv: Cloudflare.Env = env,
) {
  return app.request(
    "http://example.test/api/v1/session",
    { headers },
    requestEnv,
  );
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
});

describe("GET /api/v1/session", () => {
  it("returns only the Human identity for a valid Human token", async () => {
    const response = await sessionRequest("Bearer human-token");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(SessionResponseSchema.parse(body)).toMatchObject({
      principal: { id: "principal_human", type: "human" },
      identities: [{ identity_id: "identity_human" }],
    });
  });

  it("returns only the Agent identity for a valid Agent token with jti", async () => {
    const response = await sessionRequest("Bearer agent-token");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(SessionResponseSchema.parse(body)).toMatchObject({
      principal: { id: "principal_agent", type: "agent" },
      identities: [{ identity_id: "identity_agent" }],
    });
  });

  it("treats a tenant header as selection only", async () => {
    const response = await sessionRequest("Bearer human-token", "tenant_other");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it("uses one generic 401 body for every authentication failure", async () => {
    const headers = [
      undefined,
      "Basic human-token",
      "Bearer ",
      "Bearer wrong-signature",
      "Bearer wrong-issuer",
      "Bearer wrong-audience",
      "Bearer expired-token",
    ];
    const bodies = [];
    for (const header of headers) {
      const response = await sessionRequest(header);
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }

    expect(bodies).toHaveLength(headers.length);
    expect(
      bodies.every(
        (body) =>
          ApiErrorResponseSchema.parse(body).error.code === "unauthenticated",
      ),
    ).toBe(true);
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toHaveLength(1);
    expect(bodies[0]).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
  });

  it("returns generic not_found for a revoked principal", async () => {
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET status = 'revoked' WHERE id = ?",
    )
      .bind("principal_human")
      .run();
    const response = await sessionRequest("Bearer human-token");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it("returns generic not_found for a revoked membership", async () => {
    await env.CONTROL_DB.prepare(
      "UPDATE memberships SET status = 'revoked' WHERE id = ?",
    )
      .bind("membership_human")
      .run();
    const response = await sessionRequest("Bearer human-token");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it("keeps health public and non-secret", async () => {
    const response = await createTestApp().request(
      "http://example.test/api/v1/health",
      {},
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("does not expose subjects or routing identifiers in the session response", async () => {
    const response = await sessionRequest("Bearer human-token");
    const text = await response.text();
    expect(text).not.toContain("human-subject");
    expect(text).not.toContain("issuer.example");
    expect(text).not.toContain("route-user-human");
    expect(text).not.toContain("gateway-human");
    expect(text).not.toContain("bridge-human");
  });

  it("uses a valid Access assertion when Authorization is absent", async () => {
    const accessVerify = vi.fn(
      async (token: string): Promise<VerifiedSubject> => {
        expect(token).toBe("access.header.payload");
        return { issuer: "https://issuer.example/", subject: "human-subject" };
      },
    );
    const response = await sessionRequestWithHeaders(
      new Headers({ "Cf-Access-Jwt-Assertion": "access.header.payload" }),
      createTestApp({
        createAccessTokenVerifier: () => ({ verify: accessVerify }),
      }),
    );

    expect(response.status).toBe(200);
    expect(accessVerify).toHaveBeenCalledOnce();
  });

  it("returns the generic 401 for a malformed or invalid Access assertion", async () => {
    const accessVerify = vi.fn(async (): Promise<VerifiedSubject> => {
      throw new Error("access assertion rejected");
    });
    const app = createTestApp({
      createAccessTokenVerifier: () => ({ verify: accessVerify }),
    });
    const assertions = ["not a jwt", "access.header.payload"];
    const bodies = [];

    for (const assertion of assertions) {
      const response = await sessionRequestWithHeaders(
        new Headers({ "Cf-Access-Jwt-Assertion": assertion }),
        app,
      );
      expect(response.status).toBe(401);
      bodies.push(await response.json());
    }

    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toHaveLength(1);
    expect(bodies[0]).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
    expect(accessVerify).toHaveBeenCalledOnce();
  });

  it("rejects an oversized Access assertion before verification", async () => {
    const accessVerify = vi.fn(
      async (): Promise<VerifiedSubject> => ({
        issuer: "https://issuer.example/",
        subject: "human-subject",
      }),
    );
    const response = await sessionRequestWithHeaders(
      new Headers({
        "Cf-Access-Jwt-Assertion": `a.b.${"c".repeat(MAX_AUTH_TOKEN_CHARS)}`,
      }),
      createTestApp({
        createAccessTokenVerifier: () => ({ verify: accessVerify }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
    expect(accessVerify).not.toHaveBeenCalled();
  });

  it("never falls back to Access after an Authorization failure", async () => {
    const accessVerify = vi.fn(
      async (): Promise<VerifiedSubject> => ({
        issuer: "https://issuer.example/",
        subject: "human-subject",
      }),
    );
    const response = await sessionRequestWithHeaders(
      new Headers({
        Authorization: "Bearer invalid-bearer",
        "Cf-Access-Jwt-Assertion": "access.header.payload",
      }),
      createTestApp({
        createAccessTokenVerifier: () => ({ verify: accessVerify }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
    expect(accessVerify).not.toHaveBeenCalled();
  });

  it("does not expose Access credentials or verifier details on failure", async () => {
    const assertion = "secret-access-assertion";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await sessionRequestWithHeaders(
        new Headers({ "Cf-Access-Jwt-Assertion": assertion }),
        createTestApp({
          createAccessTokenVerifier: () => ({
            verify: async (): Promise<VerifiedSubject> => {
              throw new Error(
                `issuer=https://secret.example sub=secret-subject token=${assertion}`,
              );
            },
          }),
        }),
      );

      const body = await response.text();
      expect(response.status).toBe(401);
      expect(body).not.toContain(assertion);
      expect(body).not.toContain("secret.example");
      expect(body).not.toContain("secret-subject");
      expect(JSON.stringify(log.mock.calls)).not.toContain(assertion);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret.example");
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-subject");
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed when Access configuration is missing", async () => {
    const missingAccessConfig = {
      ...env,
      COMMUNICATOR_ACCESS_ISSUER: undefined,
      COMMUNICATOR_ACCESS_AUDIENCE: undefined,
      COMMUNICATOR_ACCESS_JWKS_URL: undefined,
    } as unknown as Cloudflare.Env;
    const response = await sessionRequestWithHeaders(
      new Headers({ "Cf-Access-Jwt-Assertion": "access.header.payload" }),
      createApp(),
      missingAccessConfig,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
  });
});
