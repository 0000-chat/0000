import { env as cloudflareEnv } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  emitPlatformDiagnostic,
  platformRequestCorrelation,
} from "../../src/diagnostics";
import { createOwnedOrganization } from "../../src/organization-state";
import { opaqueSecret } from "../../src/platform-state";
import platformWorker from "../../src/worker";
import { registerTestService } from "./fixtures/provision";
import {
  buildPlatformMiniflareRateLimits,
  buildPlatformTestRateLimitPolicy,
  buildPlatformWranglerRateLimits,
  DEFAULT_PLATFORM_RATE_LIMIT_POLICY,
  parsePlatformRateLimitPolicyJson,
  validatePlatformRateLimitPolicy,
} from "../../src/rate-limit-policy";
import {
  classifyPlatformProtectedRoute,
  executePlatformProtectedRequest,
  parsePlatformServerDeadlineMs,
  type PlatformSafeguardEnv,
} from "../../src/server-safeguards";

function testEnv(
  overrides: Partial<PlatformSafeguardEnv> = {},
): PlatformSafeguardEnv {
  const allow = { limit: async () => ({ success: true }) };
  return {
    PLATFORM_RATE_LIMIT_POLICY: "",
    PLATFORM_SERVER_DEADLINE_MS: "50",
    PLATFORM_RATE_LIMIT_LOGIN: allow,
    PLATFORM_RATE_LIMIT_ISSUANCE: allow,
    PLATFORM_RATE_LIMIT_MANAGEMENT: allow,
    PLATFORM_RATE_LIMIT_VERIFICATION: allow,
    PLATFORM_RATE_LIMIT_GUEST_CONTROL: allow,
    ...overrides,
  } as PlatformSafeguardEnv;
}

describe("Platform server safeguards", () => {
  it("validates the complete policy and generates both binding shapes", () => {
    const policy = validatePlatformRateLimitPolicy({
      login: { limit: 1, namespace_id: "1" },
      issuance: { limit: 2, namespace_id: "2" },
      management: { limit: 3, namespace_id: "3" },
      verification: { limit: 4, namespace_id: "4" },
      guestControl: { limit: 5, namespace_id: "5" },
    });
    expect(buildPlatformWranglerRateLimits(policy)).toHaveLength(5);
    expect(
      buildPlatformMiniflareRateLimits(policy).PLATFORM_RATE_LIMIT_LOGIN.simple,
    ).toEqual({ limit: 1, period: 60 });
    expect(() =>
      validatePlatformRateLimitPolicy({
        ...DEFAULT_PLATFORM_RATE_LIMIT_POLICY,
        extra: { limit: 1, namespace_id: "6" },
      }),
    ).toThrow("unknown");
    expect(() => parsePlatformRateLimitPolicyJson('{"login":{}}')).toThrow(
      "positive safe integer",
    );
    expect(buildPlatformTestRateLimitPolicy().login.limit).toBe(10_000);
  });

  it("classifies protected routes without treating public metadata as protected", () => {
    expect(
      classifyPlatformProtectedRoute(
        new Request("http://localhost/account"),
        "/account",
      ),
    ).toBe("management");
    expect(
      classifyPlatformProtectedRoute(
        new Request("http://localhost/login"),
        "/login",
      ),
    ).toBe("login");
    expect(
      classifyPlatformProtectedRoute(
        new Request("http://localhost/oauth2/selection"),
        "/oauth2/selection",
      ),
    ).toBe("issuance");
    expect(
      classifyPlatformProtectedRoute(
        new Request("http://localhost/account.js"),
        "/account.js",
      ),
    ).toBeNull();
    expect(
      classifyPlatformProtectedRoute(
        new Request("http://localhost/.well-known/oauth-authorization-server"),
        "/.well-known/oauth-authorization-server",
      ),
    ).toBeNull();
  });

  it("fails closed for missing bindings and returns a retryable exhaustion response", async () => {
    const missing = testEnv();
    delete (missing as unknown as Record<string, unknown>)
      .PLATFORM_RATE_LIMIT_LOGIN;
    let called = false;
    const unavailable = await executePlatformProtectedRequest(
      new Request("http://localhost/login"),
      missing,
      "login",
      async () => {
        called = true;
        return Response.json({ ok: true });
      },
    );
    expect(unavailable.status).toBe(503);
    expect(called).toBe(false);

    const exhausted = await executePlatformProtectedRequest(
      new Request("http://localhost/login"),
      testEnv({
        PLATFORM_RATE_LIMIT_LOGIN: {
          limit: async () => ({ success: false }),
        },
      }),
      "login",
      async () => Response.json({ ok: true }),
    );
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get("retry-after")).toBe("60");
  });

  it("returns a finite unavailable response when protected work ignores abort", async () => {
    let signal: AbortSignal | undefined;
    const response = await executePlatformProtectedRequest(
      new Request("http://localhost/login"),
      testEnv({ PLATFORM_SERVER_DEADLINE_MS: "5" }),
      "login",
      async (request) => {
        signal = request.signal;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(503);
    expect(signal?.aborted).toBe(true);
  });

  it("does not start protected work after a limiter deadline", async () => {
    let release: ((result: { success: boolean }) => void) | undefined;
    let called = false;
    const responsePromise = executePlatformProtectedRequest(
      new Request("http://localhost/login"),
      testEnv({
        PLATFORM_SERVER_DEADLINE_MS: "5",
        PLATFORM_RATE_LIMIT_LOGIN: {
          limit: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      }),
      "login",
      async () => {
        called = true;
        return Response.json({ ok: true });
      },
    );
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(called).toBe(false);
    release?.({ success: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(called).toBe(false);
  });

  it("keeps authorization independent from a failing diagnostic sink", () => {
    expect(() =>
      emitPlatformDiagnostic(
        "platform.authentication.outcome",
        "success",
        undefined,
        () => {
          throw new Error("diagnostic sink sentinel");
        },
      ),
    ).not.toThrow();
  });

  it("times out while consuming a streamed protected response body", async () => {
    let bodyPulls = 0;
    let releaseBody: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull(controller) {
        bodyPulls += 1;
        return new Promise<void>((resolve) => {
          releaseBody = () => {
            controller.close();
            resolve();
          };
        });
      },
    });
    const response = await executePlatformProtectedRequest(
      new Request("http://localhost/login"),
      testEnv({ PLATFORM_SERVER_DEADLINE_MS: "5" }),
      "login",
      async () => new Response(body),
    );
    expect(response.status).toBe(503);
    expect(bodyPulls).toBeGreaterThan(0);
    releaseBody?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("records a late D1 commit with the timeout correlation", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const userId = `t12-late-user-${crypto.randomUUID()}`;
    const resourceId = `t12-late-resource-${crypto.randomUUID()}`;
    const request = new Request("http://localhost/api/credentials");
    let writeStarted = false;
    let lateCommit: Promise<unknown> | undefined;
    const originalPrepare = database.prepare.bind(database);
    const delayedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = originalPrepare(query);
          if (!query.includes("INSERT INTO fixture_resource")) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: () => {
                  writeStarted = true;
                  return new Promise((resolve, reject) => {
                    setTimeout(() => {
                      bound.run().then(resolve, reject);
                    }, 20);
                  });
                },
              };
            },
          };
        };
      },
    }) as unknown as D1Database;
    const events: Array<Record<string, unknown>> = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => {
      try {
        events.push(JSON.parse(String(value)) as Record<string, unknown>);
      } catch {
        // Ignore unrelated console output in this focused probe.
      }
    });
    try {
      await database
        .prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, disabledAt) VALUES (?, ?, ?, 1, ?, ?, NULL)',
        )
        .bind(
          userId,
          "T12 late commit",
          `${userId}@example.test`,
          Date.now(),
          Date.now(),
        )
        .run();
      const response = await executePlatformProtectedRequest(
        request,
        testEnv({ PLATFORM_SERVER_DEADLINE_MS: "5" }),
        "management",
        async (controlledRequest) => {
          lateCommit = delayedDatabase
            .prepare(
              "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience) VALUES (?, 'organization', ?, ?, ?)",
            )
            .bind(resourceId, userId, Date.now(), "https://t12-late.test")
            .run();
          await lateCommit;
          emitPlatformDiagnostic("platform.credential.created", "success", {
            request: controlledRequest,
            principalId: userId,
            resourceId,
          });
          return Response.json({ ok: true });
        },
      );
      expect(response.status).toBe(503);
      expect(writeStarted).toBe(true);
      await lateCommit;
      const stored = await database
        .prepare("SELECT id FROM fixture_resource WHERE id = ?")
        .bind(resourceId)
        .first<{ id: string }>();
      expect(stored?.id).toBe(resourceId);
      const timeout = events.find(
        (event) => event.event === "platform.request.timed_out",
      );
      const completion = events.find(
        (event) =>
          event.event === "platform.credential.created" &&
          event.resourceId === resourceId,
      );
      expect(timeout?.outcome).toBe("timeout");
      expect(completion?.outcome).toBe("success");
      expect(completion?.correlationId).toBe(timeout?.correlationId);
      expect(platformRequestCorrelation(request)).toBe(timeout?.correlationId);
    } finally {
      log.mockRestore();
      await database
        .prepare("DELETE FROM fixture_resource WHERE id = ?")
        .bind(resourceId)
        .run();
      await database
        .prepare('DELETE FROM "user" WHERE id = ?')
        .bind(userId)
        .run();
    }
  });

  it("keeps a committed D1 mutation when the diagnostic sink fails", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const resourceId = `t12-sink-resource-${crypto.randomUUID()}`;
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("diagnostic sink sentinel");
    });
    try {
      const response = await executePlatformProtectedRequest(
        new Request("http://localhost/api/credentials"),
        testEnv({ PLATFORM_SERVER_DEADLINE_MS: "100" }),
        "management",
        async (request) => {
          await database
            .prepare(
              "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at, audience) VALUES (?, 'organization', ?, ?, ?)",
            )
            .bind(
              resourceId,
              "t12-sink-owner",
              Date.now(),
              "https://t12-sink.test",
            )
            .run();
          emitPlatformDiagnostic("platform.credential.created", "success", {
            request,
            resourceId,
          });
          return Response.json({ ok: true });
        },
      );
      expect(response.status).toBe(200);
      const stored = await database
        .prepare("SELECT id FROM fixture_resource WHERE id = ?")
        .bind(resourceId)
        .first<{ id: string }>();
      expect(stored?.id).toBe(resourceId);
    } finally {
      log.mockRestore();
      await database
        .prepare("DELETE FROM fixture_resource WHERE id = ?")
        .bind(resourceId)
        .run();
    }
  });

  it("keeps an actual guest bootstrap commit and correlated completion after timeout", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const service = {
      serviceId: `t12-late-guest-${crypto.randomUUID().slice(0, 8)}`,
      audience: `https://t12-late-guest-${crypto.randomUUID().slice(0, 8)}.test`,
      verifier: opaqueSecret("t12_service_verify_"),
      guestGrantIssuer: opaqueSecret("t12_guest_issuer_"),
      allowedCapabilities: ["resource:read"],
    };
    const startedAt = Date.now();
    let batchStarted = false;
    let releaseBatch!: () => void;
    const batchFinished = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const originalBatch = database.batch.bind(database);
    const delayedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "batch")
          return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          batchStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          const result = await originalBatch(statements);
          releaseBatch();
          return result;
        };
      },
    }) as unknown as D1Database;
    const wrappedEnv = new Proxy(cloudflareEnv, {
      get(target, property, receiver) {
        if (property === "IDENTITY_DB") return delayedDatabase;
        if (property === "PLATFORM_SERVER_DEADLINE_MS") return "5";
        return Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;
    const events: Array<Record<string, unknown>> = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => {
      try {
        events.push(JSON.parse(String(value)) as Record<string, unknown>);
      } catch {
        // Ignore unrelated output in this focused route probe.
      }
    });
    let guestId: string | undefined;
    try {
      await registerTestService(database, service);
      const response = await platformWorker.fetch(
        new Request("http://localhost/internal/v1/guests", {
          method: "POST",
          headers: { authorization: `Bearer ${service.guestGrantIssuer}` },
        }),
        wrappedEnv,
      );
      expect(response.status).toBe(503);
      expect(batchStarted).toBe(true);
      await batchFinished;
      const created = await database
        .prepare(
          "SELECT id FROM platform_guest WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(startedAt)
        .first<{ id: string }>();
      guestId = created?.id;
      expect(guestId).toBeTruthy();
      const timeout = events.find(
        (event) => event.event === "platform.request.timed_out",
      );
      const completion = events.find(
        (event) =>
          event.event === "platform.guest.bootstrap_created" &&
          event.resourceId === guestId,
      );
      expect(timeout?.outcome).toBe("timeout");
      expect(completion?.outcome).toBe("success");
      expect(completion?.correlationId).toBe(timeout?.correlationId);
    } finally {
      log.mockRestore();
      if (guestId) {
        await database
          .prepare("DELETE FROM platform_guest WHERE id = ?")
          .bind(guestId)
          .run();
      }
      await database
        .prepare(
          "DELETE FROM platform_service_grant_issuer WHERE service_id = ?",
        )
        .bind(service.serviceId)
        .run();
      await database
        .prepare("DELETE FROM platform_service WHERE service_id = ?")
        .bind(service.serviceId)
        .run();
    }
  });

  it("keeps an actual guest bootstrap mutation when the diagnostic sink throws", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const service = {
      serviceId: `t12-sink-guest-${crypto.randomUUID().slice(0, 8)}`,
      audience: `https://t12-sink-guest-${crypto.randomUUID().slice(0, 8)}.test`,
      verifier: opaqueSecret("t12_service_verify_"),
      guestGrantIssuer: opaqueSecret("t12_guest_issuer_"),
      allowedCapabilities: ["resource:read"],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("actual route diagnostic sink sentinel");
    });
    let guestId: string | undefined;
    try {
      await registerTestService(database, service);
      const response = await platformWorker.fetch(
        new Request("http://localhost/internal/v1/guests", {
          method: "POST",
          headers: { authorization: `Bearer ${service.guestGrantIssuer}` },
        }),
        cloudflareEnv,
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { guestId?: string };
      guestId = body.guestId;
      expect(guestId).toBeTruthy();
      const stored = await database
        .prepare("SELECT id FROM platform_guest WHERE id = ?")
        .bind(guestId)
        .first<{ id: string }>();
      expect(stored?.id).toBe(guestId);
    } finally {
      log.mockRestore();
      if (guestId) {
        await database
          .prepare("DELETE FROM platform_guest WHERE id = ?")
          .bind(guestId)
          .run();
      }
      await database
        .prepare(
          "DELETE FROM platform_service_grant_issuer WHERE service_id = ?",
        )
        .bind(service.serviceId)
        .run();
      await database
        .prepare("DELETE FROM platform_service WHERE service_id = ?")
        .bind(service.serviceId)
        .run();
    }
  });

  it("does not emit organization success for a zero-row conditional batch", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const userId = `t12-disabled-user-${crypto.randomUUID()}`;
    const organizationName = `T12 disabled ${userId}`;
    let committed = false;
    try {
      await database
        .prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, disabledAt) VALUES (?, ?, ?, 1, ?, ?, ?)',
        )
        .bind(
          userId,
          "T12 disabled",
          `${userId}@example.test`,
          Date.now(),
          Date.now(),
          Date.now(),
        )
        .run();
      const created = await createOwnedOrganization(
        database,
        { id: userId, name: "T12 disabled" },
        organizationName,
        () => {
          committed = true;
        },
      );
      expect(created).toBeNull();
      expect(committed).toBe(false);
      const rows = await database
        .prepare("SELECT id FROM organization WHERE name = ?")
        .bind(organizationName)
        .all<{ id: string }>();
      expect(rows.results).toHaveLength(0);
    } finally {
      await database
        .prepare('DELETE FROM "user" WHERE id = ?')
        .bind(userId)
        .run();
    }
  });

  it("emits organization completion before a follow-up read can fail", async () => {
    const database = cloudflareEnv.IDENTITY_DB;
    const userId = `t12-followup-user-${crypto.randomUUID()}`;
    const organizationName = `T12 followup ${userId}`;
    let committed: { organizationId: string; membershipId: string } | undefined;
    const originalPrepare = database.prepare.bind(database);
    const failingReadDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = originalPrepare(query);
          if (!query.includes("SELECT id FROM member")) return statement;
          return {
            bind: (..._values: unknown[]) => ({
              first: async () => {
                throw new Error("follow-up read sentinel");
              },
            }),
          };
        };
      },
    }) as unknown as D1Database;
    try {
      await database
        .prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, disabledAt) VALUES (?, ?, ?, 1, ?, ?, NULL)',
        )
        .bind(
          userId,
          "T12 followup",
          `${userId}@example.test`,
          Date.now(),
          Date.now(),
        )
        .run();
      await expect(
        createOwnedOrganization(
          failingReadDatabase,
          { id: userId, name: "T12 followup" },
          organizationName,
          (value) => {
            committed = value;
          },
        ),
      ).rejects.toThrow("follow-up read sentinel");
      expect(committed).toBeDefined();
      const stored = await database
        .prepare(
          "SELECT organization.id, member.id AS membership_id FROM organization JOIN member ON member.organizationId = organization.id WHERE organization.id = ? AND member.id = ?",
        )
        .bind(committed!.organizationId, committed!.membershipId)
        .first<{ id: string; membership_id: string }>();
      expect(stored).toEqual({
        id: committed!.organizationId,
        membership_id: committed!.membershipId,
      });
    } finally {
      if (committed) {
        await database
          .prepare("DELETE FROM member WHERE id = ?")
          .bind(committed.membershipId)
          .run();
        await database
          .prepare("DELETE FROM organization WHERE id = ?")
          .bind(committed.organizationId)
          .run();
      }
      await database
        .prepare('DELETE FROM "user" WHERE id = ?')
        .bind(userId)
        .run();
    }
  });
});
