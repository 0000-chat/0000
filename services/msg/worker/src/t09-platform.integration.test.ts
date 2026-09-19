import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin";
import { expect, test } from "bun:test";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";
import { createPlatformGuestClient } from "@0000/platform-client";
import WebSocketClient from "ws";

import { registerGuestIssuer, registerService } from "../../../platform/src/service-registration";
import { ensureDefaultOrganization, hashOpaque, issueHumanCredential, opaqueSecret, type ServiceRegistration } from "../../../platform/src/platform-state";
import { MSG_OPERATOR } from "./auth";
import { createMsgMiniflareTempDirectory, startMsgMiniflare, TEST_ROOM_LIMITS } from "../test-fixtures/msg-worker.miniflare-fixture";
import { PersistentCookieJar } from "../../cli/src/cookie-jar";

const platformRoot = fileURLToPath(new URL("../../../platform/", import.meta.url));
const platformWorkerEntry = fileURLToPath(new URL("../../../platform/src/worker.ts", import.meta.url));
const authority = "platform-t01-authority";
const audience = "https://msg.0000.chat";

interface RuntimeBridge {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function buildPlatformWorker(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [platformWorkerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("The Platform Worker bundle was not emitted.");
  return entry.text();
}

async function applyPlatformMigrations(database: D1Database): Promise<void> {
  const migrations = await readD1Migrations(join(platformRoot, "migrations"));
  for (const migration of migrations) {
    if (migration.queries.length > 0) {
      await database.batch(migration.queries.map((query) => database.prepare(query)));
    }
  }
}

async function createPlatformRuntime(script: string, persistenceDirectory: string, baseUrl: string): Promise<Miniflare> {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    bindings: {
      BETTER_AUTH_SECRET: "t09-platform-secret-with-at-least-32-characters",
      GITHUB_CLIENT_ID: "t09-github-client",
      GITHUB_CLIENT_SECRET: "t09-github-secret",
      GOOGLE_CLIENT_ID: "t09-google-client",
      GOOGLE_CLIENT_SECRET: "t09-google-secret",
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_BASE_URL: baseUrl,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_SIGNUP_POLICY: "open",
    },
    compatibilityDate: "2026-09-18",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-t09-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-t09-runtime",
    resourcePersistencePath: persistenceDirectory,
    script,
  }));
  await runtime.ready;
  return runtime;
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

function mergeCookieHeader(existing: string, response: Response): string {
  const values = new Map<string, string>();
  for (const cookie of existing.split("; ").filter(Boolean)) {
    const separator = cookie.indexOf("=");
    if (separator > 0) values.set(cookie.slice(0, separator), cookie);
  }
  for (const cookie of cookieHeader(response).split("; ").filter(Boolean)) {
    const separator = cookie.indexOf("=");
    if (separator > 0) values.set(cookie.slice(0, separator), cookie);
  }
  return [...values.values()].join("; ");
}

function cookieValue(header: string, name: string): string | undefined {
  return header.split("; ").find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function provisionHuman(
  database: D1Database,
  service: ServiceRegistration,
  email: string,
): Promise<{ credential: string; organizationId: string; subjectId: string }> {
  const subjectId = crypto.randomUUID();
  const now = Date.now();
  await database.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, disabledAt) VALUES (?, ?, ?, 1, NULL, ?, ?, NULL)',
  ).bind(subjectId, "T09 operator", email, now, now).run();
  const organization = await ensureDefaultOrganization(database, { id: subjectId, name: "T09 operator" });
  const issued = await issueHumanCredential(database, {
    service,
    userId: subjectId,
    organizationId: organization.organizationId,
    membershipId: organization.membershipId,
    capabilities: [MSG_OPERATOR],
    expiresAt: now + 86_400_000,
  });
  return { credential: issued.credential, organizationId: organization.organizationId, subjectId };
}

function roomRequest(cookies: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (cookies) headers.set("cookie", cookies);
  return {
    ...init,
    headers,
  };
}

function liveUrl(server: URL, room: string): string {
  const url = new URL(`/${room}/live?after=0`, server);
  if (url.hostname === "[::]") url.hostname = "127.0.0.1";
  url.protocol = "ws:";
  return url.toString();
}

async function openLive(server: URL, room: string, cookies: string): Promise<{ socket: WebSocketClient; ready: Promise<string> }> {
  const socket = new WebSocketClient(liveUrl(server, room), { headers: { Cookie: cookies } });
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the actual auth-enabled live handshake.")), 2_000);
    socket.once("message", (value) => {
      clearTimeout(timeout);
      resolve(value.toString());
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { ready, socket };
}

function socketClosed(socket: WebSocketClient): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for revoked live authorization to close.")), 2_000);
    socket.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test.serial("crosses the actual Platform Worker/D1 and msg Worker/DO boundary", { timeout: 45_000 }, async () => {
  const platformPersistence = await mkdtemp(join(tmpdir(), "platform-t09-d1-"));
  const msgPersistence = await createMsgMiniflareTempDirectory("t09-auth-state");
  let platform: Miniflare | undefined;
  let bridge: RuntimeBridge | undefined;
  let firstMsg: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let secondMsg: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let live: { socket: WebSocketClient; ready: Promise<string> } | undefined;
  try {
    const service = {
      serviceId: "msg-t09-runtime",
      audience,
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: ["msg:read", "msg:write", "msg:manage", "msg:operator"],
    };
    const platformScript = await buildPlatformWorker();

    // The bridge gives the actual Platform Worker a reachable origin so the
    // actual msg workerd runtime can call it through the shared clients.
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
    placeholder.server.removeAllListeners("request");
    placeholder.server.on("request", (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const result = await platform!.dispatchFetch(new Request(`${bridge!.baseUrl}${request.url ?? "/"}`, {
          method: request.method,
          headers,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        }));
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of result.headers) {
          if (name === "connection" || name === "content-length" || name === "keep-alive" || name === "transfer-encoding") continue;
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

    const database = await platform.getD1Database("IDENTITY_DB");
    await applyPlatformMigrations(database);
    await registerService(database, {
      serviceId: service.serviceId,
      audience: service.audience,
      capabilities: service.allowedCapabilities,
    }, service.verifier);
    await registerGuestIssuer(database, service.serviceId, service.guestGrantIssuer);
    const serviceRegistration: ServiceRegistration = {
      serviceId: service.serviceId,
      audience: service.audience,
      verifierHash: await hashOpaque(service.verifier),
      allowedCapabilities: service.allowedCapabilities,
    };
    const allowlistedOperator = await provisionHuman(database, serviceRegistration, "allowlisted-t09@example.test");
    const unlistedOperator = await provisionHuman(database, serviceRegistration, "unlisted-t09@example.test");
    const wrongAudienceService = {
      serviceId: "msg-t09-wrong-audience",
      audience: "https://other.0000.chat",
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: [MSG_OPERATOR],
    };
    await registerService(database, {
      serviceId: wrongAudienceService.serviceId,
      audience: wrongAudienceService.audience,
      capabilities: wrongAudienceService.allowedCapabilities,
    }, wrongAudienceService.verifier);
    const wrongAudienceServiceRegistration: ServiceRegistration = {
      serviceId: wrongAudienceService.serviceId,
      audience: wrongAudienceService.audience,
      verifierHash: await hashOpaque(wrongAudienceService.verifier),
      allowedCapabilities: wrongAudienceService.allowedCapabilities,
    };
    const wrongAudienceOperator = await provisionHuman(database, wrongAudienceServiceRegistration, "wrong-audience-t09@example.test");

    const msgBindings = {
      MSG_AUTH_REQUIRED: "1",
      MSG_PLATFORM_BASE_URL: bridge.baseUrl,
      MSG_PLATFORM_AUTHORITY: authority,
      MSG_PLATFORM_AUDIENCE: audience,
      MSG_PLATFORM_GUEST_GRANT_ISSUER: service.guestGrantIssuer,
      MSG_PLATFORM_SERVICE_VERIFIER: service.verifier,
      MSG_PUBLIC_ORIGIN: audience,
      MSG_OPERATOR_ALLOWLIST: JSON.stringify([{
        kind: "human",
        subjectId: allowlistedOperator.subjectId,
        organizationId: allowlistedOperator.organizationId,
      }]),
    };
    firstMsg = await startMsgMiniflare(msgPersistence, TEST_ROOM_LIMITS, { ...msgBindings, MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" }, false, true);
    const creationKey = crypto.randomUUID();
    const cliCookieJar = new PersistentCookieJar({ filePath: join(msgPersistence, "cli-cookies.json"), serviceOrigin: audience });
    const create = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/", {
      method: "POST",
      ...roomRequest("", { headers: { "idempotency-key": creationKey }, body: JSON.stringify({ content: "owner", author: "owner", display_name: "Owner", semantic_type: "message" }) }),
    });
    expect(create.status).toBe(201);
    const createdFromReceipt = await create.clone().json() as { room: { id: string } };
    cliCookieJar.store(`https://msg.0000.chat/${createdFromReceipt.room.id}`, create);
    let ownerCookies = cookieHeader(create);
    expect(ownerCookies).toContain("msg_guest_control=");
    expect(ownerCookies).toContain("msg_resource=");
    const created = await create.json() as { room: { id: string }; manage_url: string };
    const replay = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/", {
      method: "POST",
      ...roomRequest(ownerCookies, { headers: { "idempotency-key": creationKey }, body: JSON.stringify({ content: "owner", author: "owner", display_name: "Owner", semantic_type: "message" }) }),
    });
    expect(replay.status).toBe(201);
    const replayed = await replay.json() as { room: { id: string }; manage_url: string };
    expect(replayed.room.id).toBe(created.room.id);
    expect(replayed.manage_url).toBe(created.manage_url);
    expect(cookieValue(ownerCookies, "msg_resource")).not.toBe(cookieValue(cookieHeader(replay), "msg_resource"));
    cliCookieJar.store(`https://msg.0000.chat/${created.room.id}`, replay);
    ownerCookies = mergeCookieHeader(ownerCookies, replay);

    const operatorStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${allowlistedOperator.credential}`, accept: "application/json" },
    });
    expect(operatorStatus.status).toBe(200);
    const unlistedStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${unlistedOperator.credential}`, accept: "application/json" },
    });
    expect(unlistedStatus.status).toBe(403);
    await database.prepare('UPDATE "user" SET disabledAt = ? WHERE id = ?').bind(Date.now(), unlistedOperator.subjectId).run();
    const disabledStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${unlistedOperator.credential}`, accept: "application/json" },
    });
    expect(disabledStatus.status).toBe(401);
    const guestOperatorStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${cookieValue(ownerCookies, "msg_resource") ?? ""}`, accept: "application/json" },
    });
    expect(guestOperatorStatus.status).toBe(403);
    const wrongAudienceStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${wrongAudienceOperator.credential}`, accept: "application/json" },
    });
    expect(wrongAudienceStatus.status).toBe(401);
    await database.prepare("UPDATE platform_credential SET revoked_at = ? WHERE subject_id = ? AND kind = 'human'").bind(Date.now(), allowlistedOperator.subjectId).run();
    const revokedOperatorStatus = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/operator/v1/status", {
      headers: { authorization: `Bearer ${allowlistedOperator.credential}`, accept: "application/json" },
    });
    expect(revokedOperatorStatus.status).toBe(401);

    const ownerRead = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(ownerCookies));
    expect(ownerRead.status).toBe(200);
    const participantRead = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(""));
    expect(participantRead.status).toBe(200);
    const participantCookies = cookieHeader(participantRead);
    expect(participantCookies).toContain("msg_guest_control=");
    expect(participantCookies).toContain("msg_resource=");
    const participantPost = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(participantCookies, {
      method: "POST",
      body: JSON.stringify({ content: "participant", author: "participant", display_name: "Participant", semantic_type: "message" }),
    }));
    expect(participantPost.status).toBe(201);
    const invalidManagement = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/manage/${created.room.id}/wrong`, roomRequest(participantCookies));
    expect(invalidManagement.status).toBe(404);
    const management = await firstMsg.miniflare.dispatchFetch(created.manage_url, roomRequest(ownerCookies));
    expect(management.status).toBe(200);
    let managementCookies = mergeCookieHeader(ownerCookies, management);
    const managementGrantBeforeRecovery = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND permission_id = 'msg-management' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    expect(managementGrantBeforeRecovery?.id).toBeString();
    const recoveredManagement = await firstMsg.miniflare.dispatchFetch(`${created.manage_url}?recover=1`, roomRequest(managementCookies));
    expect(recoveredManagement.status).toBe(200);
    managementCookies = mergeCookieHeader(managementCookies, recoveredManagement);
    const managementGrantAfterRecovery = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND permission_id = 'msg-management' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    expect(managementGrantAfterRecovery?.id).toBe(managementGrantBeforeRecovery?.id);

    const ownerGrant = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND assertion_kind = 'owner' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    expect(ownerGrant?.id).toBeString();
    const cliSocketCookies = cliCookieJar.websocketHeaders(`wss://msg.0000.chat/${created.room.id}/live`).Cookie;
    expect(cliSocketCookies).toContain("msg_guest_control=");
    expect(cliSocketCookies).toContain("msg_resource=");
    live = await openLive(await firstMsg.miniflare.ready, created.room.id, cliSocketCookies ?? "");
    expect(JSON.parse(await live.ready)).toMatchObject({ type: "ready", latest_message: 2 });
    const platformGuest = createPlatformGuestClient({
      baseUrl: bridge.baseUrl,
      authority,
      audience,
      guestGrantIssuer: service.guestGrantIssuer,
    });
    if (!ownerGrant) throw new Error("The actual Platform owner grant was not stored.");
    expect(await platformGuest.revokeGuestGrant(ownerGrant.id)).toEqual({ status: "success", revoked: true });
    const revokedLiveClose = socketClosed(live.socket);
    const participantPostAfterRevoke = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(participantCookies, {
      method: "POST",
      body: JSON.stringify({ content: "after revoke", author: "participant", display_name: "Participant", semantic_type: "message" }),
    }));
    expect(participantPostAfterRevoke.status).toBe(201);
    expect(await revokedLiveClose).toBe(1008);
    const revokedOwner = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(ownerCookies));
    expect(revokedOwner.status).toBe(401);
    const recoveredOwner = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}?recover=1`, roomRequest(ownerCookies));
    expect(recoveredOwner.status).toBe(200);
    ownerCookies = mergeCookieHeader(ownerCookies, recoveredOwner);
    const managementGrant = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND permission_id = 'msg-management' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    const publicGrant = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND permission_id = 'msg-public' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    expect(managementGrant?.id).toBeString();
    expect(publicGrant?.id).toBeString();
    const ownerControl = cookieValue(ownerCookies, "msg_guest_control");
    expect(ownerControl).toBeString();
    const recoveredPublic = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}?recover=1`, roomRequest(`msg_guest_control=${ownerControl}`));
    expect(recoveredPublic.status).toBe(200);
    ownerCookies = mergeCookieHeader(ownerCookies, recoveredPublic);
    const publicGrantAfterRecovery = await database.prepare(
      "SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND permission_id = 'msg-public' AND revoked_at IS NULL",
    ).bind(service.serviceId, created.room.id).first<{ id: string }>();
    expect(publicGrantAfterRecovery?.id).toBe(publicGrant.id);
    if (!managementGrant) throw new Error("The actual Platform management grant was not stored.");
    expect(await platformGuest.revokeGuestGrant(managementGrant.id)).toEqual({ status: "success", revoked: true });
    const revokedManagement = await firstMsg.miniflare.dispatchFetch(created.manage_url, roomRequest(managementCookies));
    expect(revokedManagement.status).toBe(401);
    const unrelatedPublic = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(ownerCookies));
    expect(unrelatedPublic.status).toBe(200);
    const unrelatedParticipant = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(participantCookies));
    expect(unrelatedParticipant.status).toBe(200);

    await firstMsg.dispose();
    firstMsg = undefined;
    secondMsg = await startMsgMiniflare(msgPersistence, TEST_ROOM_LIMITS, { ...msgBindings, MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" }, false, true);
    const restartedParticipant = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(participantCookies));
    expect(restartedParticipant.status).toBe(200);
    expect((await restartedParticipant.json() as { latest_message: number }).latest_message).toBe(3);

    await platform.dispose();
    platform = undefined;
    const authorityOutage = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${created.room.id}`, roomRequest(participantCookies));
    expect(authorityOutage.status).toBe(503);
  } finally {
    live?.socket.close();
    await secondMsg?.dispose();
    await firstMsg?.dispose();
    await bridge?.close();
    await platform?.dispose();
    await rm(platformPersistence, { force: true, recursive: true });
    await rm(msgPersistence, { force: true, recursive: true });
    await rm(`${msgPersistence}-d1`, { force: true, recursive: true });
  }
});
