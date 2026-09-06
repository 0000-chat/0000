import { env as runtimeEnv } from "cloudflare:workers";
import {
  ApiErrorResponseSchema,
  SessionResponseSchema,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import { clearDirectory, seedDirectory } from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };

function createTestApp() {
  return createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return { issuer: "https://issuer.example/", subject: "human-subject" };
        }
        if (token === "agent-token") {
          return { issuer: "https://issuer.example/", subject: "agent-subject", token_id: "agent-token-id" };
        }
        throw new Error("invalid local test token");
      },
    }),
  });
}

async function sessionRequest(authHeader?: string, tenant?: string) {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set("Authorization", authHeader);
  if (tenant !== undefined) headers.set("X-Communicator-Tenant", tenant);
  return createTestApp().request("http://example.test/api/v1/session", { headers }, env);
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
    expect(bodies.every((body) => ApiErrorResponseSchema.parse(body).error.code === "unauthenticated")).toBe(true);
    expect(new Set(bodies.map((body) => JSON.stringify(body)))).toHaveLength(1);
    expect(bodies[0]).toEqual({
      error: { code: "unauthenticated", message: "Authentication required" },
    });
  });

  it("returns generic not_found for a revoked principal", async () => {
    await env.CONTROL_DB.prepare("UPDATE principals SET status = 'revoked' WHERE id = ?")
      .bind("principal_human").run();
    const response = await sessionRequest("Bearer human-token");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it("returns generic not_found for a revoked membership", async () => {
    await env.CONTROL_DB.prepare("UPDATE memberships SET status = 'revoked' WHERE id = ?")
      .bind("membership_human").run();
    const response = await sessionRequest("Bearer human-token");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Resource not found" },
    });
  });

  it("keeps health public and non-secret", async () => {
    const response = await createTestApp().request("http://example.test/api/v1/health", {}, env);
    expect(response.status).toBe(200);
    expect((await response.json())).toMatchObject({ status: "ok" });
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
});
