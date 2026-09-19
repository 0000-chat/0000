import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin";
import { expect, test } from "bun:test";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare";
import { Database } from "bun:sqlite";
import WebSocketClient from "ws";

import { registerGuestIssuer, registerService } from "../../../platform/src/service-registration";
import { ensureDefaultOrganization, hashOpaque, issueHumanCredential, opaqueSecret, type ServiceRegistration } from "../../../platform/src/platform-state";
import { MSG_CLAIM, MSG_MANAGE, MSG_READ, MSG_WRITE } from "./auth";
import { createMsgMiniflareTempDirectory, startMsgMiniflare, TEST_ROOM_LIMITS } from "../test-fixtures/msg-worker.miniflare-fixture";

const platformRoot = fileURLToPath(new URL("../../../platform/", import.meta.url));
const platformWorkerEntry = fileURLToPath(new URL("../../../platform/src/worker.ts", import.meta.url));
const authority = "platform-t10-authority";
const audience = "https://msg.0000.chat";

async function buildPlatformWorker(): Promise<string> {
  const result = await Bun.build({ entrypoints: [platformWorkerEntry], external: ["cloudflare:workers"], format: "esm", naming: "worker.js", target: "browser" });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("The Platform Worker bundle was not emitted.");
  // Reading the emitted bytes avoids Bun's intermittent output.text() stall
  // seen in the shared CI boundary harness.
  return new TextDecoder().decode(await entry.arrayBuffer());
}

async function applyPlatformMigrations(database: D1Database): Promise<void> {
  const migrations = await readD1Migrations(join(platformRoot, "migrations"));
  for (const migration of migrations) if (migration.queries.length > 0) await database.batch(migration.queries.map((query) => database.prepare(query)));
}

async function createPlatformRuntime(script: string, persistenceDirectory: string, baseUrl: string): Promise<Miniflare> {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    bindings: {
      BETTER_AUTH_SECRET: "t10-platform-secret-with-at-least-32-characters",
      GITHUB_CLIENT_ID: "t10-github-client",
      GITHUB_CLIENT_SECRET: "t10-github-secret",
      GOOGLE_CLIENT_ID: "t10-google-client",
      GOOGLE_CLIENT_SECRET: "t10-google-secret",
      PLATFORM_AUTHORITY_ID: authority,
      PLATFORM_BASE_URL: baseUrl,
      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
      PLATFORM_SIGNUP_POLICY: "open",
    },
    compatibilityDate: "2026-09-18",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-t10-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-t10-runtime",
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

function cookieValue(header: string, name: string): string | undefined {
  return header.split("; ").find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
}

function mergeCookies(existing: string, response: Response): string {
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

function roomRequest(cookies: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (cookies) headers.set("cookie", cookies);
  return { ...init, headers };
}

async function openLive(server: URL, room: string, headers: Record<string, string>): Promise<{ socket: WebSocketClient; ready: Promise<string> }> {
  const url = new URL(`/${room}/live?after=0`, server);
  url.protocol = "ws:";
  const socket = new WebSocketClient(url.toString(), { headers });
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for T10 authenticated live handshake.")), 2_000);
    socket.once("message", (value) => { clearTimeout(timeout); resolve(value.toString()); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  return { socket, ready };
}

function socketMessage(socket: WebSocketClient): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for T10 live frame.")), 2_000);
    socket.once("message", (value) => { clearTimeout(timeout); resolve(value.toString()); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function socketClosed(socket: WebSocketClient): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for T10 live close.")), 2_000);
    socket.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function provisionHuman(database: D1Database, service: ServiceRegistration, email: string, capabilities: string[]): Promise<{ credential: string; organizationId: string; subjectId: string }> {
  const subjectId = crypto.randomUUID();
  const now = Date.now();
  await database.prepare('INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, disabledAt) VALUES (?, ?, ?, 1, NULL, ?, ?, NULL)').bind(subjectId, "T10 claimant", email, now, now).run();
  const organization = await ensureDefaultOrganization(database, { id: subjectId, name: `T10 ${email}` });
  const issued = await issueHumanCredential(database, {
    service,
    userId: subjectId,
    organizationId: organization.organizationId,
    membershipId: organization.membershipId,
    capabilities,
    expiresAt: now + 86_400_000,
  });
  return { credential: issued.credential, organizationId: organization.organizationId, subjectId };
}

test.serial("proves atomic guest-to-organization claim across Platform, DO restart, and concurrent contenders", { timeout: 60_000 }, async () => {
  const platformPersistence = await mkdtemp(join(tmpdir(), "platform-t10-d1-"));
  const msgPersistence = await createMsgMiniflareTempDirectory("t10-claim-state");
  let platform: Miniflare | undefined;
  let firstMsg: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let secondMsg: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
  let bridgeServer: ReturnType<typeof createServer> | undefined;
  let organizationLive: WebSocketClient | undefined;
  let revokedParticipantLive: WebSocketClient | undefined;
  try {
    const service = {
      serviceId: "msg-t10-runtime",
      audience,
      verifier: opaqueSecret("service_verify_"),
      guestGrantIssuer: opaqueSecret("service_guest_grant_"),
      allowedCapabilities: [MSG_READ, MSG_WRITE, MSG_MANAGE, MSG_CLAIM],
    };
    const platformScript = await buildPlatformWorker();
    const bridge = await new Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Platform bridge did not expose a TCP address."));
        resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
      });
    });
    bridgeServer = bridge.server;
    platform = await createPlatformRuntime(platformScript, platformPersistence, bridge.baseUrl);
    bridge.server.on("request", (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        const result = await platform!.dispatchFetch(new Request(`${bridge.baseUrl}${request.url ?? "/"}`, { method: request.method, headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) }));
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of result.headers) if (!["connection", "content-length", "keep-alive", "transfer-encoding"].includes(name)) responseHeaders[name] = value;
        const responseBody = Buffer.from(await result.arrayBuffer());
        responseHeaders["content-length"] = String(responseBody.byteLength);
        response.writeHead(result.status, responseHeaders);
        response.end(responseBody);
      })().catch((error: unknown) => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
    });
    const database = await platform.getD1Database("IDENTITY_DB");
    await applyPlatformMigrations(database);
    await registerService(database, { serviceId: service.serviceId, audience: service.audience, capabilities: service.allowedCapabilities }, service.verifier);
    await registerGuestIssuer(database, service.serviceId, service.guestGrantIssuer);
    const registration: ServiceRegistration = { serviceId: service.serviceId, audience: service.audience, verifierHash: await hashOpaque(service.verifier), allowedCapabilities: service.allowedCapabilities };
    const claimant = await provisionHuman(database, registration, "claimant-t10@example.test", [MSG_READ, MSG_WRITE, MSG_MANAGE, MSG_CLAIM]);
    const otherClaimant = await provisionHuman(database, registration, "other-claimant-t10@example.test", [MSG_READ, MSG_WRITE, MSG_MANAGE, MSG_CLAIM]);
    const underprivileged = await provisionHuman(database, registration, "underprivileged-t10@example.test", [MSG_READ]);
    const revokedClaimant = await provisionHuman(database, registration, "revoked-claimant-t10@example.test", [MSG_CLAIM]);
    await database.prepare("UPDATE platform_credential SET revoked_at = ? WHERE subject_id = ? AND kind = 'human'").bind(Date.now(), revokedClaimant.subjectId).run();

    const msgBindings = {
      MSG_AUTH_REQUIRED: "1",
      MSG_PLATFORM_BASE_URL: bridge.baseUrl,
      MSG_PLATFORM_AUTHORITY: authority,
      MSG_PLATFORM_AUDIENCE: audience,
      MSG_PLATFORM_GUEST_GRANT_ISSUER: service.guestGrantIssuer,
      MSG_PLATFORM_SERVICE_VERIFIER: service.verifier,
      MSG_PUBLIC_ORIGIN: audience,
    };
    firstMsg = await startMsgMiniflare(msgPersistence, TEST_ROOM_LIMITS, { ...msgBindings, MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" }, false, true);

    const creationKey = crypto.randomUUID();
    const create = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/", { method: "POST", ...roomRequest("", { headers: { "idempotency-key": creationKey }, body: JSON.stringify({ content: "claimable", author: "owner", display_name: "Owner", semantic_type: "message" }) }) });
    expect(create.status).toBe(201);
    const created = await create.clone().json() as { room: { id: string }; manage_url: string };
    const room = created.room.id;
    const ownerCookies = cookieHeader(create);
    const control = cookieValue(ownerCookies, "msg_guest_control");
    expect(control).toBeString();

    const participant = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest(""));
    expect(participant.status).toBe(200);
    const participantCookies = cookieHeader(participant);
    const managementBefore = await firstMsg.miniflare.dispatchFetch(created.manage_url, roomRequest(ownerCookies));
    expect(managementBefore.status).toBe(200);
    const managementCredential = cookieValue(cookieHeader(managementBefore), "msg_management");
    expect(managementCredential).toBeString();

    const claimKey = crypto.randomUUID();
    const claim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": claimKey }, body: JSON.stringify({}) }) });
    expect(claim.status).toBe(200);
    const claimValue = await claim.clone().json() as { room: string; organization_id: string; revoke_links: boolean; claimed_at: string };
    expect(claimValue).toMatchObject({ room, organization_id: claimant.organizationId, revoke_links: false });

    const formerOwner = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest(ownerCookies));
    expect(formerOwner.status).toBe(403);
    const oldManagement = await firstMsg.miniflare.dispatchFetch(created.manage_url, roomRequest(ownerCookies));
    expect(oldManagement.status).toBe(404);
    const preservedParticipant = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest(participantCookies));
    expect(preservedParticipant.status).toBe(200);

    const orgHeaders = { authorization: `Bearer ${claimant.credential}` };
    const organizationRead = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { headers: orgHeaders }));
    expect(organizationRead.status).toBe(200);
    const organizationExport = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/export.json`, roomRequest("", { headers: orgHeaders }));
    expect(organizationExport.status).toBe(200);
    const organizationConnection = await openLive(await firstMsg.miniflare.ready, room, orgHeaders);
    organizationLive = organizationConnection.socket;
    expect(JSON.parse(await organizationConnection.ready)).toMatchObject({ type: "ready", latest_message: 1 });
    const organizationFrame = socketMessage(organizationLive);
    const organizationPost = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { method: "POST", headers: orgHeaders, body: JSON.stringify({ content: "organization", author: "human", display_name: "Claimant", semantic_type: "message" }) }));
    expect(organizationPost.status).toBe(201);
    expect(JSON.parse(await organizationFrame)).toMatchObject({ type: "message.created", sequence: 2 });
    const organizationManage = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/manage`, roomRequest("", { headers: orgHeaders }));
    expect(organizationManage.status).toBe(200);
    const foreign = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { headers: { authorization: `Bearer ${otherClaimant.credential}` } }));
    expect(foreign.status).toBe(403);
    const underprivilegedPost = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { method: "POST", headers: { authorization: `Bearer ${underprivileged.credential}` }, body: JSON.stringify({ content: "denied", author: "human", display_name: "Read only", semantic_type: "message" }) }));
    expect(underprivilegedPost.status).toBe(403);
    const invalidExplicitBearer = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest(ownerCookies, { headers: { authorization: "Bearer revoked-or-invalid" } }));
    expect(invalidExplicitBearer.status).toBe(401);
    const malformedClaimBody = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ organization_id: "attacker-org" }) }) });
    expect(malformedClaimBody.status).toBe(400);
    const publicCredential = cookieValue(participantCookies, "msg_resource");
    const publicOnlyClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${publicCredential ?? ""}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(publicOnlyClaim.status).toBe(403);
    const managementOnlyClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${managementCredential ?? ""}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(managementOnlyClaim.status).toBe(403);
    const underprivilegedClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${underprivileged.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(underprivilegedClaim.status).toBe(403);
    const revokedClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${revokedClaimant.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(revokedClaim.status).toBe(401);

    const exactRetry = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": claimKey }, body: JSON.stringify({}) }) });
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toEqual(claimValue);
    const changedOptions = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": claimKey }, body: JSON.stringify({ revoke_links: true }) }) });
    expect(changedOptions.status).toBe(409);
    const changedClaimant = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${otherClaimant.credential}`, "idempotency-key": claimKey }, body: JSON.stringify({}) }) });
    expect(changedClaimant.status).toBe(409);
    const guestOnlyClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(participantCookies, { headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(guestOnlyClaim.status).toBe(401);
    const missingControlClaim = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest("", { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) });
    expect(missingControlClaim.status).toBe(403);

    const secondCreate = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/", { method: "POST", ...roomRequest(ownerCookies, { headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ content: "race", author: "owner", display_name: "Owner", semantic_type: "message" }) }) });
    expect(secondCreate.status).toBe(201);
    const secondRoom = (await secondCreate.clone().json() as { room: { id: string } }).room.id;
    const raceKey = crypto.randomUUID();
    const [raceA, raceB] = await Promise.all([
      firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${secondRoom}/claim`, { method: "POST", ...roomRequest(mergeCookies(ownerCookies, secondCreate), { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": raceKey }, body: JSON.stringify({}) }) }),
      firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${secondRoom}/claim`, { method: "POST", ...roomRequest(mergeCookies(ownerCookies, secondCreate), { headers: { authorization: `Bearer ${otherClaimant.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({}) }) }),
    ]);
    expect([raceA.status, raceB.status].filter((status) => status === 200)).toHaveLength(1);
    expect([raceA.status, raceB.status].some((status) => status === 403 || status === 409)).toBe(true);

    const revokeCreate = await firstMsg.miniflare.dispatchFetch("https://msg.0000.chat/", { method: "POST", ...roomRequest(ownerCookies, { headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ content: "revoke", author: "owner", display_name: "Owner", semantic_type: "message" }) }) });
    const revokeRoom = (await revokeCreate.clone().json() as { room: { id: string } }).room.id;
    const revokeParticipant = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${revokeRoom}`, roomRequest(""));
    expect(revokeParticipant.status).toBe(200);
    const revokedParticipantConnection = await openLive(await firstMsg.miniflare.ready, revokeRoom, { cookie: cookieHeader(revokeParticipant) });
    revokedParticipantLive = revokedParticipantConnection.socket;
    await revokedParticipantConnection.ready;
    const revokedClose = socketClosed(revokedParticipantLive);
    const revoke = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${revokeRoom}/claim`, { method: "POST", ...roomRequest(mergeCookies(ownerCookies, revokeCreate), { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ revoke_links: true }) }) });
    expect(revoke.status).toBe(200);
    const postAfterRevoke = await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${revokeRoom}`, roomRequest("", { method: "POST", headers: orgHeaders, body: JSON.stringify({ content: "after-revoke", author: "human", display_name: "Claimant", semantic_type: "message" }) }));
    expect(postAfterRevoke.status).toBe(201);
    expect(await revokedClose).toBe(1008);
    expect((await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${revokeRoom}`, roomRequest(cookieHeader(revokeParticipant)))).status).toBe(403);
    expect((await firstMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${revokeRoom}`, roomRequest(""))).status).toBe(404);

    const local = new Database(":memory:");
    local.exec("CREATE TABLE tenant (id TEXT PRIMARY KEY, owner_organization_id TEXT NOT NULL); CREATE TABLE resource (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, creation_guest_id TEXT NOT NULL, owner_guest_id TEXT, owner_subject_id TEXT, receipt_key TEXT UNIQUE); CREATE TABLE claim_receipts (receipt_key TEXT PRIMARY KEY, claimant_subject_id TEXT NOT NULL, claimant_credential TEXT NOT NULL, organization_id TEXT NOT NULL)");
    local.query("INSERT INTO tenant (id, owner_organization_id) VALUES (?, ?)").run("tenant-t10", claimant.organizationId);
    local.query("INSERT INTO resource (id, tenant_id, creation_guest_id, owner_guest_id) VALUES (?, ?, ?, ?)").run(room, "tenant-t10", control ?? "", control ?? "");
    local.transaction(() => {
      local.query("UPDATE resource SET owner_guest_id = NULL, owner_subject_id = ?, receipt_key = ? WHERE id = ? AND owner_guest_id = ?").run(claimant.subjectId, claimKey, room, control ?? "");
      local.query("INSERT INTO claim_receipts (receipt_key, claimant_subject_id, claimant_credential, organization_id) VALUES (?, ?, ?, ?)").run(claimKey, claimant.subjectId, claimant.credential, claimant.organizationId);
    })();
    expect(local.query("SELECT creation_guest_id, owner_guest_id, owner_subject_id, receipt_key FROM resource WHERE id = ?").get(room)).toEqual({ creation_guest_id: control, owner_guest_id: null, owner_subject_id: claimant.subjectId, receipt_key: claimKey });
    expect(local.query("SELECT claimant_subject_id, claimant_credential, organization_id FROM claim_receipts WHERE receipt_key = ?").get(claimKey)).toEqual({ claimant_subject_id: claimant.subjectId, claimant_credential: claimant.credential, organization_id: claimant.organizationId });
    local.close();

    await firstMsg.dispose();
    firstMsg = undefined;
    secondMsg = await startMsgMiniflare(msgPersistence, TEST_ROOM_LIMITS, { ...msgBindings, MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" }, false, true);
    const restartedOrgRead = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { headers: orgHeaders }));
    expect(restartedOrgRead.status).toBe(200);
    const restartedRetry = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}/claim`, { method: "POST", ...roomRequest(ownerCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": claimKey }, body: JSON.stringify({}) }) });
    expect(restartedRetry.status).toBe(200);
    const creationReplayAfterClaim = await secondMsg.miniflare.dispatchFetch("https://msg.0000.chat/", { method: "POST", ...roomRequest(ownerCookies, { headers: { "idempotency-key": creationKey }, body: JSON.stringify({ content: "claimable", author: "owner", display_name: "Owner", semantic_type: "message" }) }) });
    expect(creationReplayAfterClaim.status).toBe(403);

    const outageCreate = await secondMsg.miniflare.dispatchFetch("https://msg.0000.chat/", { method: "POST", ...roomRequest(ownerCookies, { headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ content: "outage", author: "owner", display_name: "Owner", semantic_type: "message" }) }) });
    expect(outageCreate.status).toBe(201);
    const outageValue = await outageCreate.clone().json() as { room: { id: string } };
    const outageRoom = outageValue.room.id;
    const outageCookies = mergeCookies(ownerCookies, outageCreate);
    const outageClaimKey = crypto.randomUUID();
    await platform.dispose();
    platform = undefined;
    const claimDuringOutage = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${outageRoom}/claim`, { method: "POST", ...roomRequest(outageCookies, { headers: { authorization: `Bearer ${claimant.credential}`, "idempotency-key": outageClaimKey }, body: JSON.stringify({}) }) });
    expect(claimDuringOutage.status).toBe(503);
    platform = await createPlatformRuntime(platformScript, platformPersistence, bridge.baseUrl);
    const ownerAfterOutage = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${outageRoom}`, roomRequest(outageCookies));
    expect(ownerAfterOutage.status).toBe(200);
    await platform.dispose();
    platform = undefined;
    const outage = await secondMsg.miniflare.dispatchFetch(`https://msg.0000.chat/${room}`, roomRequest("", { headers: orgHeaders }));
    expect(outage.status).toBe(503);
  } finally {
    organizationLive?.close();
    revokedParticipantLive?.close();
    await secondMsg?.dispose();
    await firstMsg?.dispose();
    if (bridgeServer) await new Promise<void>((resolve) => bridgeServer!.close(() => resolve()));
    await platform?.dispose();
    await rm(platformPersistence, { force: true, recursive: true });
    await rm(msgPersistence, { force: true, recursive: true });
    await rm(`${msgPersistence}-d1`, { force: true, recursive: true });
  }
});
