import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformClient } from "@0000/platform-client";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { opaqueSecret } from "../src/platform-state.ts";
import { handleResourceRequest } from "../worker/test/fixtures/resource-service.ts";
import { registerTestService } from "../worker/test/fixtures/provision.ts";

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const platformBaseUrl = "http://localhost";
const authority = "platform-t01-authority";
const audience = "https://fixture.0000.test";

async function buildWorkerScript() {
  const result = await Bun.build({
    entrypoints: [workerEntry],
    external: ["cloudflare:workers"],
    format: "esm",
    naming: "worker.js",
    target: "browser",
  });
  if (!result.success) {
    throw new Error(
      `Worker bundle failed: ${result.logs.map((log) => log.message).join("\n")}`,
    );
  }
  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("Worker bundle entry point was not emitted");
  return entry.text();
}

async function applyMigrations(database, migrationsPath) {
  const migrations = await readD1Migrations(migrationsPath);
  for (const migration of migrations) {
    if (migration.queries.length === 0) continue;
    await database.batch(
      migration.queries.map((query) => database.prepare(query)),
    );
  }
}

function createRuntime(script, persistenceDirectory) {
  const options = convertV4MiniflareOptions({
    bindings: {
      PLATFORM_BASE_URL: platformBaseUrl,
      PLATFORM_AUTHORITY_ID: authority,
      GITHUB_CLIENT_ID: "platform-t01-probe",
      GITHUB_CLIENT_SECRET: "local-probe-only",
      BETTER_AUTH_SECRET: "local-probe-secret-not-for-deployment",
    },
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { IDENTITY_DB: "platform-identity" },
    host: "127.0.0.1",
    modules: true,
    name: "platform-t01-restart-probe",
    resourcePersistencePath: persistenceDirectory,
    script,
  });
  return new Miniflare(options);
}

async function expectStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label} status`);
}

const persistenceDirectory = await mkdtemp(join(tmpdir(), "platform-t01-d1-"));
const workerScript = await buildWorkerScript();
let first;
let second;
let failed = false;
let failure;

try {
  first = createRuntime(workerScript, persistenceDirectory);
  await first.ready;
  const firstFetch = (input, init) => first.dispatchFetch(input, init);
  const database = await first.getD1Database("IDENTITY_DB");
  await applyMigrations(database, join(platformRoot, "migrations"));
  await applyMigrations(
    database,
    join(platformRoot, "worker/test/fixtures/migrations"),
  );

  const service = {
    serviceId: "fixture-resource-service",
    audience,
    verifier: opaqueSecret("service_verify_"),
    guestGrantIssuer: opaqueSecret("service_guest_grant_"),
    allowedCapabilities: ["resource:read"],
  };
  await registerTestService(database, service);

  const bootstrap = await firstFetch(`${platformBaseUrl}/api/guest/bootstrap`, {
    method: "POST",
    headers: { origin: platformBaseUrl },
  });
  await expectStatus(bootstrap, 201, "guest bootstrap");
  const guest = await bootstrap.json();
  assert.ok(
    typeof guest.guestId === "string" && typeof guest.credential === "string",
    "bootstrap credentials returned",
  );

  await database
    .prepare(
      "INSERT INTO fixture_resource (id, owner_kind, owner_id, created_at) VALUES (?, 'guest', ?, ?)",
    )
    .bind("restart-resource", guest.guestId, Date.now())
    .run();
  const grantResponse = await firstFetch(
    `${platformBaseUrl}/internal/v1/guest-grants`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${service.guestGrantIssuer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        guestCredential: guest.credential,
        resourceId: "restart-resource",
        resourceOwnerId: guest.guestId,
        capabilities: ["resource:read"],
      }),
    },
  );
  await expectStatus(grantResponse, 201, "bounded guest grant");
  const grant = await grantResponse.json();
  assert.ok(
    typeof grant.credential === "string" &&
      typeof grant.credentialId === "string",
    "resource grant returned",
  );

  const beforeRestart = createPlatformClient({
    baseUrl: platformBaseUrl,
    authority,
    audience,
    serviceVerifier: service.verifier,
    fetch: firstFetch,
  });
  const beforeResult = await beforeRestart.authenticate(grant.credential);
  assert.equal(
    beforeResult.status,
    "authenticated",
    "grant authenticates before runtime disposal",
  );

  await first.dispose();
  first = undefined;

  second = createRuntime(workerScript, persistenceDirectory);
  await second.ready;
  const secondFetch = (input, init) => second.dispatchFetch(input, init);
  const persistedDatabase = await second.getD1Database("IDENTITY_DB");
  const afterRestart = createPlatformClient({
    baseUrl: platformBaseUrl,
    authority,
    audience,
    serviceVerifier: service.verifier,
    fetch: secondFetch,
  });
  const afterResult = await afterRestart.authenticate(grant.credential);
  assert.equal(
    afterResult.status,
    "authenticated",
    "grant authenticates after a fresh workerd runtime starts",
  );
  if (afterResult.status === "authenticated") {
    assert.equal(
      afterResult.principal.kind,
      "guest",
      "persisted principal kind",
    );
    if (afterResult.principal.kind === "guest") {
      assert.equal(
        afterResult.principal.subjectId,
        guest.guestId,
        "persisted guest identity",
      );
      assert.deepEqual(
        afterResult.principal.resourceIds,
        ["restart-resource"],
        "persisted resource boundary",
      );
    }
  }

  const resourceResponse = await handleResourceRequest(
    new Request("https://fixture.test/resources/restart-resource", {
      headers: { authorization: `Bearer ${grant.credential}` },
    }),
    {
      database: persistedDatabase,
      platformBaseUrl,
      authority,
      audience,
      serviceVerifier: service.verifier,
      guestGrantIssuer: service.guestGrantIssuer,
      fetch: secondFetch,
    },
  );
  await expectStatus(resourceResponse, 200, "persisted resource authorization");
  console.log("Miniflare D1 runtime restart persistence probe passed.");
} catch (error) {
  failed = true;
  failure = error;
} finally {
  for (const runtime of [second, first]) {
    try {
      await runtime?.dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  try {
    await rm(persistenceDirectory, { force: true, recursive: true });
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
}

if (failed) throw failure;
