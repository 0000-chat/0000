import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

const routes = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/oauth/authorize",
  "/oauth/callback",
  "/oauth/consent",
  "/oauth/token",
] as const;

describe("retired local OAuth issuer", () => {
  it("fails closed for every retired discovery and issuer endpoint", async () => {
    const app = createApp({
      // A historical verifier must not re-enable the local issuer.
      createTokenVerifier: () => ({
        verify: async () => ({
          issuer: "https://legacy-issuer.test",
          subject: "legacy-subject",
        }),
      }),
    });

    for (const path of routes) {
      const method =
        path === "/oauth/consent" || path === "/oauth/token" ? "POST" : "GET";
      const response = await app.request(
        `https://communicator.test${path}`,
        {
          method,
          headers:
            method === "POST"
              ? { "Content-Type": "application/json" }
              : undefined,
          body: method === "POST" ? "{}" : undefined,
        },
        env,
      );
      expect(response.status, path).toBe(503);
      expect(await response.json(), path).toMatchObject({
        error: "temporarily_unavailable",
      });
    }
  });
});
