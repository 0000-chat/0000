import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const workerEnv = env as typeof env & { CONTROL_DB: D1Database };

describe("published live read OpenAPI document", () => {
  beforeEach(async () => {
    await clearDirectory(workerEnv.CONTROL_DB);
    await seedDirectory(workerEnv.CONTROL_DB);
  });

  it("publishes the registered 3.1 read paths without authentication", async () => {
    const response = await createApp().request(
      "http://example.test/api/v1/openapi.json",
      {},
      workerEnv,
    );
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<
        string,
        {
          get?: {
            security?: unknown;
            responses?: Record<string, unknown>;
          };
          post?: {
            security?: unknown;
            responses?: Record<string, unknown>;
          };
        }
      >;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({
      title: "Communicator API",
      version: "1.0.0",
    });
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/health",
        "/api/v1/session",
        "/api/v1/identities",
        "/api/v1/connections",
        "/api/v1/identities/{identity_id}/channels",
        "/api/v1/identities/{identity_id}/conversations",
        "/api/v1/identities/{identity_id}/conversations/{conversation_id}",
        "/api/v1/conversations/{conversation_id}/messages",
        "/api/v1/realtime/tickets",
        "/api/v1/removals/restore-authority",
        "/api/v1/removals/restore-projection",
        "/api/v1/removals/restore-activation-lease",
        "/api/v1/removals/restore-activation-lease/release",
      ]),
    );
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("declares bounded error responses and bearer security on every protected read operation", async () => {
    const response = await createApp().request(
      "http://example.test/api/v1/openapi.json",
      {},
      workerEnv,
    );
    const document = (await response.json()) as {
      paths: Record<
        string,
        {
          get?: {
            security?: unknown;
            responses?: Record<string, unknown>;
          };
          post?: {
            security?: unknown;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    const protectedPaths = [
      "/api/v1/session",
      "/api/v1/identities",
      "/api/v1/connections",
      "/api/v1/identities/{identity_id}/channels",
      "/api/v1/identities/{identity_id}/conversations",
      "/api/v1/identities/{identity_id}/conversations/{conversation_id}",
      "/api/v1/conversations/{conversation_id}/messages",
    ];
    for (const path of protectedPaths) {
      const operation = document.paths[path]?.get;
      expect(operation?.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(["200", "400", "401", "404", "503"]),
      );
    }

    const ticketOperation = document.paths["/api/v1/realtime/tickets"]?.post;
    expect(ticketOperation?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(ticketOperation?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "400", "401", "404", "503"]),
    );
    expect(document.paths["/api/v1/realtime"]).toBeUndefined();

    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("projection_forbidden");
    expect(serialized).not.toContain("projection_unavailable");
    expect(serialized).not.toContain("projection_rebuilding");
  });
});
