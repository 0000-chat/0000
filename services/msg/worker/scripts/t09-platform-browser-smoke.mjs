import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlatformGuestClient } from "@0000/platform-client";
import { convertV4MiniflareOptions, Miniflare } from "../../../platform/node_modules/miniflare/dist/src/index.js";
import { readD1Migrations } from "../../../platform/node_modules/@cloudflare/vitest-plugin/dist/pool/index.mjs";
import { registerGuestIssuer, registerService } from "../../../platform/src/service-registration";
import { opaqueSecret } from "../../../platform/src/platform-state";
import { chromium } from "/home/ubuntu/0000-full/worktrees/platform-mvp/services/communicator/node_modules/.pnpm/@playwright+test@1.62.1/node_modules/@playwright/test/index.mjs";

import { createMsgMiniflareTempDirectory, startMsgMiniflare, TEST_ROOM_LIMITS } from "../test-fixtures/msg-worker.miniflare-fixture.ts";

const platformRoot = fileURLToPath(new URL("../../../platform/", import.meta.url));
const platformWorkerEntry = fileURLToPath(new URL("../../../platform/src/worker.ts", import.meta.url));
const authority = "platform-t09-browser-authority";
const audience = "https://msg.0000.chat";
const service = {
  serviceId: "msg-t09-browser",
  audience,
  verifier: opaqueSecret("service_verify_"),
  guestGrantIssuer: opaqueSecret("service_guest_grant_"),
  allowedCapabilities: ["msg:read", "msg:write", "msg:manage"],
};

async function buildPlatformWorker() {
  const result = await Bun.build({
    entrypoints: [platformWorkerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("The Platform Worker bundle was not emitted.");
  return entry.text();
}

async function applyPlatformMigrations(database) {
  const migrations = await readD1Migrations(join(platformRoot, "migrations"));
  for (const migration of migrations) {
    if (migration.queries.length > 0) await database.batch(migration.queries.map((query) => database.prepare(query)));
  }
}

function responseBody(response) {
  return response.arrayBuffer().then((value) => Buffer.from(value));
}

async function listenBridge() {
  let platform;
  const server = createServer((request, response) => {
    void (async () => {
      if (!platform) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "platform unavailable" }));
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const result = await platform.dispatchFetch(new Request(`http://127.0.0.1:${server.address().port}${request.url ?? "/"}`, {
        method: request.method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      }));
      const outputHeaders = {};
      for (const [name, value] of result.headers) {
        if (name === "connection" || name === "content-length" || name === "keep-alive" || name === "transfer-encoding") continue;
        outputHeaders[name] = value;
      }
      const body = await responseBody(result);
      outputHeaders["content-length"] = String(body.byteLength);
      response.writeHead(result.status, outputHeaders);
      response.end(body);
    })().catch((error) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setPlatform(value) { platform = value; },
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

async function waitForMessage(page, value) {
  await page.locator("#messages .message").filter({ hasText: value }).first().waitFor({ state: "visible", timeout: 5_000 });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser runtime state.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main() {
  const platformPersistence = await mkdtemp(join(tmpdir(), "platform-t09-browser-d1-"));
  const msgPersistence = await createMsgMiniflareTempDirectory("t09-browser-auth-state");
  const bridge = await listenBridge();
  let platform;
  let msg;
  let browser;
  const browserErrors = [];
  try {
    const platformScript = await buildPlatformWorker();
    platform = new Miniflare(convertV4MiniflareOptions({
      bindings: {
        BETTER_AUTH_SECRET: "t09-browser-secret-with-at-least-32-characters",
        GITHUB_CLIENT_ID: "t09-browser-github-client",
        GITHUB_CLIENT_SECRET: "t09-browser-github-secret",
        GOOGLE_CLIENT_ID: "t09-browser-google-client",
        GOOGLE_CLIENT_SECRET: "t09-browser-google-secret",
        PLATFORM_AUTHORITY_ID: authority,
        PLATFORM_BASE_URL: bridge.baseUrl,
        PLATFORM_DEPLOYMENT_MODE: "self-hosted",
        PLATFORM_SIGNUP_POLICY: "open",
      },
      compatibilityDate: "2026-09-18",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { IDENTITY_DB: "platform-t09-browser-identity" },
      host: "127.0.0.1",
      modules: true,
      name: "platform-t09-browser-runtime",
      resourcePersistencePath: platformPersistence,
      script: platformScript,
    }));
    bridge.setPlatform(platform);
    await platform.ready;
    const database = await platform.getD1Database("IDENTITY_DB");
    await applyPlatformMigrations(database);
    await registerService(database, {
      serviceId: service.serviceId,
      audience: service.audience,
      capabilities: service.allowedCapabilities,
    }, service.verifier);
    await registerGuestIssuer(database, service.serviceId, service.guestGrantIssuer);

    msg = await startMsgMiniflare(
      msgPersistence,
      TEST_ROOM_LIMITS,
      {
        MSG_AUTH_REQUIRED: "1",
        MSG_DATA_ENCRYPTION_KEY_V1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        MSG_PLATFORM_BASE_URL: bridge.baseUrl,
        MSG_PLATFORM_AUTHORITY: authority,
        MSG_PLATFORM_AUDIENCE: audience,
        MSG_PLATFORM_GUEST_GRANT_ISSUER: service.guestGrantIssuer,
        MSG_PLATFORM_SERVICE_VERIFIER: service.verifier,
        MSG_PUBLIC_ORIGIN: audience,
      },
      false,
      true,
    );
    const msgOrigin = await msg.miniflare.ready;
    const ownerContext = await chromium.launchPersistentContext(join(msgPersistence, "browser-profile"), { headless: true });
    browser = ownerContext.browser();
    const owner = await ownerContext.newPage();
    const participantContext = await browser.newContext();
    const participant = await participantContext.newPage();
    for (const page of [owner, participant]) {
      await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
      page.on("pageerror", (error) => browserErrors.push(error.message));
    }
    let ownerSocketCloses = 0;
    owner.on("websocket", (socket) => socket.on("close", () => { ownerSocketCloses += 1; }));

    await owner.goto(`${msgOrigin}/`);
    const created = await owner.evaluate(async () => {
      const response = await fetch("/", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ content: "owner initial", author: "Owner", display_name: "Owner", semantic_type: "message" }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(created.status, 201);
    assert.equal((await ownerContext.cookies()).some((cookie) => cookie.name === "msg_guest_control"), true);
    assert.equal((await ownerContext.cookies()).some((cookie) => cookie.name === "msg_resource"), true);
    const room = new URL(created.body.conversation_url).pathname.split("/").filter(Boolean)[0];
    assert.ok(room);
    const roomUrl = new URL(room, msgOrigin).toString();
    const humanRoomUrl = `${roomUrl}?view=human`;
    const ownerRoomResponse = await owner.goto(humanRoomUrl);
    assert.equal(ownerRoomResponse?.status(), 200);
    await waitForMessage(owner, "owner initial");
    await participant.goto(humanRoomUrl);
    assert.equal((await participant.locator("#messages").count()), 1);
    await waitForMessage(participant, "owner initial");
    assert.equal((await participantContext.cookies()).some((cookie) => cookie.name === "msg_resource"), true);

    await owner.locator("#reply").fill("owner reply");
    await owner.getByRole("button", { name: "Post reply", exact: true }).click();
    await waitForMessage(owner, "owner reply");
    await waitForMessage(participant, "owner reply");
    await owner.reload();
    await waitForMessage(owner, "owner reply");
    await owner.waitForFunction(() => document.querySelector("#connection-status")?.textContent === "Live");

    const ownerGrant = await database.prepare("SELECT id FROM platform_guest_grant WHERE service_id = ? AND resource_id = ? AND assertion_kind = 'owner' AND revoked_at IS NULL").bind(service.serviceId, room).first();
    assert.ok(ownerGrant?.id);
    const platformGuest = createPlatformGuestClient({ baseUrl: bridge.baseUrl, authority, audience, guestGrantIssuer: service.guestGrantIssuer });
    assert.deepEqual(await platformGuest.revokeGuestGrant(ownerGrant.id), { status: "success", revoked: true });
    await participant.locator("#reply").fill("participant after revoke");
    await participant.getByRole("button", { name: "Post reply", exact: true }).click();
    await waitForMessage(participant, "participant after revoke");
    await waitFor(() => ownerSocketCloses > 0);
    assert.ok(ownerSocketCloses > 0, "revocation must close the browser live socket after the next delivery");
    const deniedPost = owner.waitForResponse((response) => new URL(response.url()).pathname === `/${room}` && response.request().method() === "POST");
    await owner.locator("#reply").fill("preserved draft");
    await owner.getByRole("button", { name: "Post reply", exact: true }).click();
    assert.equal((await deniedPost).status(), 401);
    const pendingMessage = owner.locator("#messages .message").filter({ hasText: "preserved draft" }).first();
    await pendingMessage.waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await pendingMessage.textContent(), /Pending/);
    await owner.goto(`${roomUrl}?view=human&recover=1`);
    await waitForMessage(owner, "participant after revoke");

    await platform.dispose();
    platform = undefined;
    const outage = await participant.evaluate(async () => {
      const response = await fetch(location.pathname, { headers: { accept: "application/json" } });
      return { status: response.status, body: await response.text() };
    });
    assert.equal(outage.status, 503);
    assert.match(outage.body, /temporarily unavailable/i);
    assert.equal(browserErrors.length, 0, browserErrors.join("\n"));
    console.log("PASS: Chromium owner/participant create, read, post, reload/reconnect, grant revocation, preserved denied draft, explicit recovery, and Platform outage.");
  } finally {
    await browser?.close().catch(() => {});
    await msg?.dispose().catch(() => {});
    await platform?.dispose().catch(() => {});
    await bridge.close().catch(() => {});
    await rm(platformPersistence, { force: true, recursive: true });
    await rm(msgPersistence, { force: true, recursive: true });
    await rm(`${msgPersistence}-d1`, { force: true, recursive: true });
  }
}

await main();
