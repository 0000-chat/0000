import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin";
import { expect, test } from "bun:test";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";
import { createPlatformGuestClient } from "@0000/platform-client";

import { registerGuestIssuer, registerService } from "../../../platform/src/service-registration";
import { opaqueSecret } from "../../../platform/src/platform-state";
import {
  buildPlatformMiniflareRateLimits,
  buildPlatformTestRateLimitPolicy,
} from "../../../platform/src/rate-limit-policy";
import {
  buildWorkerBundleInChild,
  createMsgMiniflareTempDirectory,
  isMsgPlatformScenarioChild,
  runMsgPlatformScenarioInChild,
  startMsgMiniflare,
  TEST_ROOM_LIMITS,
} from "../test-fixtures/msg-worker.miniflare-fixture";
import type { MsgRateLimitPolicy } from "../../scripts/msg-rate-limit-policy";

const platformRoot = fileURLToPath(new URL("../../../platform/", import.meta.url));
const platformWorkerEntry = fileURLToPath(new URL("../../../platform/src/worker.ts", import.meta.url));
const authority = "platform-t13-authority";
const audience = "https://msg.0000.chat";
const platformRateLimitPolicy = buildPlatformTestRateLimitPolicy();

interface RuntimeBridge {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.();
  if (values && values.length > 0) return values;
  const combined = response.headers.get("set-cookie") ?? "";
  return combined.split(/, (?=[^;=]+=[^;]+)/u).filter(Boolean);
}

function cookieHeader(response: Response): string {
  return setCookies(response).map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function cookieValue(header: string, name: string): string | undefined {
  return header.split("; ").find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
}

function roomRequest(cookies: string, actor: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cf-connecting-ip", actor);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (cookies) headers.set("cookie", cookies);
  return { ...init, headers };
}

async function applyPlatformMigrations(database: D1Database): Promise<void> {
  const migrations = await readD1Migrations(join(platformRoot, "migrations"));
  for (const migration of migrations) {
    if (migration.queries.length > 0) await database.batch(migration.queries.map((query) => database.prepare(query)));
  }
}

async function createPlatformRuntime(script: string, persistenceDirectory: string, baseUrl: string): Promise<Miniflare> {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    bindings: {
      BETTER_AUTH_SECRET: "t13-platform-secret-with-at-least-32-characters",
      GITHUB_CLIENT_ID: "t13-github-client",
      GITHUB_CLIENT_SECRET: "t13-github-secret",
      GOOGLE_CLIENT_ID: "t13-google-client",
      GOOGLE_CLIENT_SECRET: "t13-google-secret",
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_BASE_URL: baseUrl,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_RATE_LIMIT_POLICY: JSON.stringify(platformRateLimitPolicy),
      PLATFORM_SERVER_DEADLINE_MS: "8000",
      PLATFORM_SIGNUP_POLICY: "open",
    },
    compatibilityDate: "2026-09-18",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-t13-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-t13-runtime",
    ratelimits: buildPlatformMiniflareRateLimits(platformRateLimitPolicy),
    resourcePersistencePath: persistenceDirectory,
    script,
  }));
  await runtime.ready;
  return runtime;
}

async function installPlatformBridge(server: Server, platform: Miniflare, baseUrl: string): Promise<void> {
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await platform.dispatchFetch(new Request(`${baseUrl}${request.url ?? "/"}`, {
        method: request.method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      }));
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of result.headers) {
        if (["connection", "content-length", "keep-alive", "transfer-encoding"].includes(name)) continue;
        responseHeaders[name] = value;
      }
      const responseBody = Buffer.from(await result.arrayBuffer());
      responseHeaders["content-length"] = String(responseBody.byteLength);
      response.writeHead(result.status, responseHeaders);
      response.end(responseBody);
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
}

test.serial("keeps the configured msg quota after a genuinely new Platform guest is issued", { timeout: 45_000 }, async () => {
  const scenarioFile = fileURLToPath(import.meta.url);
  if (!isMsgPlatformScenarioChild("t13-quota", scenarioFile)) {
    await runMsgPlatformScenarioInChild({ scenario: "t13-quota", scenarioFile, timeoutMs: 45_000 });
    return;
  }
  const platformPersistence = await mkdtemp(join(tmpdir(), "platform-t13-d1-"));
  const msgPersistence = await createMsgMiniflareTempDirectory("t13-quota-state");
  let platform: Miniflare | undefined;
  let bridge: RuntimeBridge | undefined;
  let msg: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  try {
    const service = {
      serviceId: "msg-t13-runtime",
      audience,
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["msg:read", "msg:write"],
    };
    const platformScript = await buildWorkerBundleInChild(platformWorkerEntry);
    const placeholder = await new Promise<{ server: Server; baseUrl: string }>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Platform bridge did not expose a TCP address."));
        resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
      });
    });
    bridge = {
      baseUrl: placeholder.baseUrl,
      close: () => new Promise<void>((resolve, reject) => placeholder.server.close((error) => error ? reject(error) : resolve())),
    };
    platform = await createPlatformRuntime(platformScript, platformPersistence, bridge.baseUrl);
    await installPlatformBridge(placeholder.server, platform, bridge.baseUrl);

    const database = await platform.getD1Database("IDENTITY_DB");
    await applyPlatformMigrations(database);
    await registerService(database, {
      serviceId: service.serviceId,
      audience: service.audience,
      capabilities: service.allowedCapabilities,
    }, service.verifier);
    await registerGuestIssuer(database, service.serviceId, service.guestGrantIssuer);

    const policy: MsgRateLimitPolicy = {
      creation: { limit: 10, namespace_id: "913201" },
      reads: { limit: 100, namespace_id: "913202" },
      posts: { limit: 1, namespace_id: "913203" },
      live: { limit: 10, namespace_id: "913204" },
    };
    msg = await startMsgMiniflare(msgPersistence, TEST_ROOM_LIMITS, {
      MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      MSG_PLATFORM_BASE_URL: bridge.baseUrl,
      MSG_PLATFORM_AUTHORITY: authority,
      MSG_PLATFORM_AUDIENCE: audience,
      MSG_PLATFORM_GUEST_GRANT_ISSUER: service.guestGrantIssuer,
      MSG_PLATFORM_SERVICE_VERIFIER: service.verifier,
      MSG_PUBLIC_ORIGIN: audience,
    }, false, true, policy);

    const actor = "198.51.100.10";
    const create = await msg.miniflare.dispatchFetch("https://msg.0000.chat/", roomRequest("", actor, {
      method: "POST",
      body: JSON.stringify({ content: "owner", author: "owner", display_name: "Owner", semantic_type: "message" }),
    }));
    expect(create.status).toBe(201);
    const ownerCookies = cookieHeader(create);
    const created = await create.json() as { room: { id: string } };
    const originalControl = cookieValue(ownerCookies, "msg_guest_control");
    expect(originalControl).toBeString();

    const platformGuest = createPlatformGuestClient({
      baseUrl: bridge.baseUrl,
      authority,
      audience,
      guestGrantIssuer: service.guestGrantIssuer,
    });
    const originalGuest = await platformGuest.resolveGuestControl(decodeURIComponent(originalControl!));
    expect(originalGuest.status).toBe("success");
    if (originalGuest.status !== "success") throw new Error("The original Platform guest was not issued.");

    const firstPost = await msg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(ownerCookies, actor, {
      method: "POST",
      body: JSON.stringify({ content: "first post", author: "owner", display_name: "Owner", semantic_type: "message" }),
    }));
    expect(firstPost.status).toBe(201);

    const rateLimitedWebhook = await msg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}/webhooks`, roomRequest(ownerCookies, actor, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com/msg-t13-hook" }),
    }));
    expect(rateLimitedWebhook.status).toBe(429);
    expect(rateLimitedWebhook.headers.get("retry-after")).toBe("60");

    const newGuest = await platformGuest.createGuest();
    expect(newGuest.status).toBe("success");
    if (newGuest.status !== "success") throw new Error("The fresh Platform guest was not issued.");
    expect(newGuest.guestId).not.toBe(originalGuest.guestId);
    const freshControl = `msg_guest_control=${encodeURIComponent(newGuest.bootstrapCredential)}`;
    const deniedPost = await msg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(freshControl, actor, {
      method: "POST",
      body: JSON.stringify({ content: "denied post", author: "new guest", display_name: "New guest", semantic_type: "message" }),
    }));
    expect(deniedPost.status).toBe(429);
    expect(deniedPost.headers.get("retry-after")).toBe("60");
    expect(await deniedPost.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests. Retry later." } });

    const transcript = await msg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(ownerCookies, actor));
    expect(transcript.status).toBe(200);
    expect((await transcript.json() as { latest_message: number }).latest_message).toBe(2);
  } finally {
    await msg?.dispose();
    await bridge?.close();
    await platform?.dispose();
    await rm(platformPersistence, { force: true, recursive: true });
    await rm(msgPersistence, { force: true, recursive: true });
    await rm(`${msgPersistence}-d1`, { force: true, recursive: true });
  }
});
