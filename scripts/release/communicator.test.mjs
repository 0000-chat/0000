import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { affectedUnits, makePlan, readReleaseConfig, repositoryRoot, sha256, stableJson } from "./lib.mjs";
import { workspaceClosure, bridgeImages } from "./communicator.mjs";
import { archiveFiles, assertForwardState, verifyComposition } from "./verify-communicator.mjs";

const config = readReleaseConfig();
const composition = ["communicator-bridge-images", "communicator-control-plane", "communicator-matrix-gateway", "platform-worker"];
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: repositoryRoot, maxBuffer: 128 * 1024 * 1024, ...options });

test("Communicator units select a complete same-revision composition and public dependencies", () => {
  for (const file of ["services/communicator/apps/control-plane/worker/index.ts", "services/communicator/services/matrix-gateway/src/main.rs", "services/communicator/deploy/images.lock.env"]) {
    assert.deepEqual(affectedUnits(config, [file]).map((unit) => unit.name), composition);
  }
  assert.deepEqual(affectedUnits(config, ["packages/contracts/src/index.ts"]).map((unit) => unit.name), config.units.map((unit) => unit.name).sort());
  assert.deepEqual(affectedUnits(config, ["packages/contracts/src/index.test.ts"]), []);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "communicator-closure-"));
  try {
    const app = path.join(temporary, "services/communicator/apps/control-plane");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ dependencies: { "@0000/contracts": "workspace:*" } }));
    assert.throws(() => workspaceClosure(temporary), /required workspace dependency/);
    const lock = fs.readFileSync(path.join(repositoryRoot, "services/communicator/deploy/images.lock.env"), "utf8");
    assert.equal(Object.keys(bridgeImages(lock)).length, 6);
    assert.throws(() => bridgeImages(lock.replace(/@sha256:[a-f0-9]{64}/, "")), /digest-pinned/);
    assert.throws(() => bridgeImages(lock.split("\n").slice(1).join("\n")), /missing required/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("clean consumer verifies, extracts and restarts the actual release composition", { timeout: 900_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "communicator-consumer-"));
  const artifacts = path.join(temporary, "artifacts");
  const extracted = path.join(temporary, "extracted");
  const commit = run("git", ["rev-parse", "HEAD"]).toString().trim();
  const plan = makePlan({ config, base: commit, head: commit, changedFiles: ["services/communicator/apps/control-plane/worker/index.ts"] });
  const planFile = path.join(temporary, "plan.json");
  const recordFile = path.join(temporary, "record.json");
  const verifier = path.join(temporary, "verify-communicator.mjs");
  fs.writeFileSync(planFile, stableJson(plan));
  fs.copyFileSync(path.join(repositoryRoot, "scripts/release/verify-communicator.mjs"), verifier);
  const cli = [verifier, "--record", recordFile, "--artifact-dir", artifacts, "--commit", commit, "--api", "v1", "--config", "v1"];
  try {
    run("node", ["scripts/release/build.mjs", "--plan", planFile, "--output-dir", artifacts]);
    run("node", ["scripts/release/record.mjs", "--plan", planFile, "--artifact-dir", artifacts, "--output", recordFile]);
    const record = JSON.parse(fs.readFileSync(recordFile));
    const inputs = { record, directory: artifacts, commit, compatibility: { api: "v1", config: "v1" } };
    const manifests = verifyComposition(inputs);

    await t.test("standalone CLI requires attestation, not just matching checksums", () => {
      const attestations = path.join(temporary, "missing-attestations");
      fs.mkdirSync(attestations);
      for (const malformed of [false, true]) {
        if (malformed) for (const artifact of record.artifacts) {
          fs.writeFileSync(path.join(attestations, `${artifact.asset_name}.jsonl`), "not a Sigstore bundle\n");
        }
        const result = spawnSync("node", [...cli, "--attestation-dir", attestations, "--extract", extracted], { cwd: temporary, encoding: "utf8" });
        assert.notEqual(result.status, 0, malformed ? "invalid attestation" : "missing attestation");
        assert.match(result.stderr, /attestation|bundle/);
        assert.equal(fs.existsSync(extracted), false);
      }
      assert.match(run("node", [...cli, "--local-integrity-only", "--extract", extracted], { cwd: temporary }).toString(), /signatures\/provenance NOT verified/);
      assert.equal(fs.existsSync(path.join(temporary, "node_modules")), false);
      assert.equal(fs.existsSync(path.join(extracted, "packages")), false);
      assert.deepEqual(fs.readdirSync(extracted).sort(), composition);
      assert.deepEqual(record.cloud_selection.artifacts.map((entry) => entry.name), ["platform-worker"]);
    });

    await t.test("attestation cannot authenticate replacement bytes instead of the checked archive", () => {
      const artifact = record.artifacts.find((entry) => entry.name === "communicator-control-plane");
      const external = path.join(artifacts, artifact.asset_name);
      const original = fs.readFileSync(external);
      const replacement = Buffer.concat([original, Buffer.from("different signed subject")]);
      const destination = path.join(temporary, "race-extracted");
      try {
        assert.throws(() => verifyComposition({ ...inputs, extract: destination, attest: (archive) => {
          if (path.basename(archive) !== artifact.asset_name) return;
          fs.writeFileSync(external, replacement);
          assert.equal(sha256(fs.readFileSync(archive)), sha256(replacement), "attestation subject mismatch");
        } }), /attestation subject mismatch/);
        assert.equal(fs.existsSync(destination), false);
        fs.writeFileSync(external, original);
        verifyComposition({ ...inputs, attest: (archive) => {
          if (path.basename(archive) !== artifact.asset_name) return;
          fs.writeFileSync(external, replacement);
          assert.equal(sha256(fs.readFileSync(archive)), artifact.digest.slice("sha256:".length));
          fs.writeFileSync(external, original);
        } });
      } finally { fs.writeFileSync(external, original); }
    });

    await t.test("missing, altered and mixed-version bundles fail before extraction", () => {
      for (const name of composition) {
        const missing = structuredClone(record);
        missing.artifacts = missing.artifacts.filter((entry) => entry.name !== name);
        assert.throws(() => verifyComposition({ ...inputs, record: missing }), /missing or duplicate required artifact/);
      }
      const wrong = structuredClone(record);
      wrong.artifacts[0].version = `v0.0.0-${"1".repeat(40)}`;
      assert.throws(() => verifyComposition({ ...inputs, record: wrong }), /incompatible bundle version/);
      assert.throws(() => verifyComposition({ ...inputs, commit: "2".repeat(40) }), /wrong source revision/);
      assert.throws(() => verifyComposition({ ...inputs, compatibility: { api: "v2", config: "v1" } }), /unsupported compatibility/);
      const file = path.join(artifacts, record.artifacts[0].asset_name);
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from("tampered")]));
      assert.throws(() => verifyComposition(inputs), /archive checksum mismatch/);
      fs.writeFileSync(file, original);
      fs.renameSync(file, `${file}.missing`);
      assert.throws(() => verifyComposition(inputs), /ENOENT/);
      fs.renameSync(`${file}.missing`, file);
      try {
        fs.truncateSync(file, 256 * 1024 * 1024 + 1);
        assert.throws(() => verifyComposition(inputs), /archive exceeds 256 MiB limit/);
      } finally { fs.writeFileSync(file, original); }
    });

    await t.test("consumer rejects a rehashed manifest missing public dependency closure", () => {
      const artifact = record.artifacts.find((entry) => entry.name === "communicator-control-plane");
      const archive = path.join(artifacts, artifact.asset_name);
      const original = fs.readFileSync(archive);
      const files = archiveFiles(original);
      const repack = path.join(temporary, "repack");
      fs.mkdirSync(repack);
      for (const [name, file] of files) {
        fs.mkdirSync(path.dirname(path.join(repack, name)), { recursive: true });
        fs.writeFileSync(path.join(repack, name), file.bytes, { mode: file.mode });
      }
      for (const dependency of ["@0000/contracts", "@0000/platform-client"]) {
        const manifest = structuredClone(manifests[artifact.name]);
        manifest.dependencies = manifest.dependencies.filter((entry) => entry.name !== dependency);
        const manifestBytes = Buffer.from(stableJson(manifest));
        fs.writeFileSync(path.join(repack, "artifact-manifest.json"), manifestBytes);
        const tar = run("tar", ["--format=ustar", "-cf", "-", "-C", repack, ...fs.readdirSync(repack)]);
        const changed = gzipSync(tar);
        fs.writeFileSync(archive, changed);
        const modified = structuredClone(record);
        Object.assign(modified.artifacts.find((entry) => entry.name === artifact.name), { digest: `sha256:${sha256(changed)}`, manifest_digest: `sha256:${sha256(manifestBytes)}` });
        assert.throws(() => verifyComposition({ ...inputs, record: modified }), /required contracts\/platform-client closure/);
      }
      fs.writeFileSync(archive, original);
    });

    await t.test("forward migration metadata preserves old ledgers and persistent state", () => {
      assert.doesNotThrow(() => verifyComposition({ ...inputs, previous: manifests }));
      const prior = manifests["communicator-control-plane"];
      const appended = structuredClone(prior);
      appended.migration_files.push({ name: "migrations/9999_future.sql", digest: `sha256:${"a".repeat(64)}` });
      assert.doesNotThrow(() => assertForwardState(prior, appended));
      assert.throws(() => assertForwardState(appended, prior), /not append-only/);
      const edited = structuredClone(prior);
      edited.migration_files[0].digest = `sha256:${"b".repeat(64)}`;
      assert.throws(() => assertForwardState(prior, edited), /not append-only/);
      edited.state.compatibility = "unknown";
      assert.throws(() => assertForwardState(prior, edited), /incompatible persistent-state/);
      const native = structuredClone(manifests["communicator-matrix-gateway"]);
      native.state.embedded_schema[0].digest = `sha256:${"c".repeat(64)}`;
      assert.throws(() => assertForwardState(manifests[native.name], native), /migration review required/);
      for (const mutate of [
        (ledger) => { ledger[0].digest = `sha256:${"d".repeat(64)}`; },
        (ledger) => { ledger.push({ name: "migrations/9999_future.sql", digest: `sha256:${"e".repeat(64)}` }); },
      ]) {
        const previous = structuredClone(manifests);
        mutate(previous["platform-worker"].migration_files);
        assert.throws(() => verifyComposition({ ...inputs, previous }), /not append-only/);
      }
    });

    await t.test("Worker upgrades preserve Durable Object classes and exports before extraction", () => {
      const artifact = record.artifacts.find((entry) => entry.name === "communicator-control-plane");
      const archive = path.join(artifacts, artifact.asset_name);
      const original = fs.readFileSync(archive);
      const files = archiveFiles(original);
      const repack = path.join(temporary, "worker-identity-repack");
      const destination = path.join(temporary, "invalid-worker-identity-extraction");
      const mutations = [
        (bindings) => { bindings.durable_objects.bindings.find((entry) => entry.name === "TENANT_PROJECTION").class_name = "LinkSessionDO"; },
        (bindings) => { bindings.durable_objects.bindings.find((entry) => entry.name === "TENANT_PROJECTION").script_name = "another-worker"; },
        (bindings) => { bindings.exports.TenantProjectionDO.storage = "kv"; },
        (bindings) => { delete bindings.exports.TenantProjectionDO; },
      ];
      try {
        for (const mutate of mutations) {
          fs.rmSync(repack, { recursive: true, force: true });
          for (const [name, file] of files) {
            fs.mkdirSync(path.dirname(path.join(repack, name)), { recursive: true });
            fs.writeFileSync(path.join(repack, name), file.bytes, { mode: file.mode });
          }
          const manifest = structuredClone(manifests[artifact.name]);
          mutate(manifest.bindings);
          const configBytes = Buffer.from(stableJson(manifest.bindings));
          fs.writeFileSync(path.join(repack, "wrangler.json"), configBytes);
          manifest.files.find((entry) => entry.name === "wrangler.json").digest = `sha256:${sha256(configBytes)}`;
          const manifestBytes = Buffer.from(stableJson(manifest));
          fs.writeFileSync(path.join(repack, "artifact-manifest.json"), manifestBytes);
          const changed = gzipSync(run("tar", ["--format=ustar", "-cf", "-", "-C", repack, ...fs.readdirSync(repack)]));
          fs.writeFileSync(archive, changed);
          const modified = structuredClone(record);
          Object.assign(modified.artifacts.find((entry) => entry.name === artifact.name), { digest: `sha256:${sha256(changed)}`, manifest_digest: `sha256:${sha256(manifestBytes)}` });
          assert.throws(() => verifyComposition({ ...inputs, record: modified, previous: manifests, extract: destination }), /Durable Object.*changed/);
          assert.equal(fs.existsSync(destination), false);
        }
      } finally { fs.writeFileSync(archive, original); }
    });

    await t.test("Platform SQL must match its complete ordered ledger before extraction", () => {
      const artifact = record.artifacts.find((entry) => entry.name === "platform-worker");
      const archive = path.join(artifacts, artifact.asset_name);
      const original = fs.readFileSync(archive);
      const files = archiveFiles(original);
      const repack = path.join(temporary, "platform-repack");
      const destination = path.join(temporary, "invalid-platform-extraction");
      const mutations = [
        (manifest) => { fs.appendFileSync(path.join(repack, manifest.migration_files[0].name), "\n-- changed SQL bytes\n"); },
        (manifest) => { fs.rmSync(path.join(repack, manifest.migration_files[0].name)); },
        () => { fs.writeFileSync(path.join(repack, "migrations/9999_undeclared.sql"), "SELECT 1;\n"); },
        (manifest) => { manifest.migration_files.reverse(); },
        (manifest) => { manifest.migration_files.push(manifest.migration_files[0]); },
      ];
      try {
        for (const mutate of mutations) {
          fs.rmSync(repack, { recursive: true, force: true });
          for (const [name, file] of files) {
            fs.mkdirSync(path.dirname(path.join(repack, name)), { recursive: true });
            fs.writeFileSync(path.join(repack, name), file.bytes, { mode: file.mode });
          }
          const manifest = structuredClone(manifests[artifact.name]);
          mutate(manifest);
          fs.writeFileSync(path.join(repack, "artifact-manifest.json"), stableJson(manifest));
          const changed = gzipSync(run("tar", ["--format=ustar", "-cf", "-", "-C", repack, ...fs.readdirSync(repack)]));
          fs.writeFileSync(archive, changed);
          const modified = structuredClone(record);
          modified.artifacts.find((entry) => entry.name === artifact.name).digest = `sha256:${sha256(changed)}`;
          assert.throws(() => verifyComposition({ ...inputs, record: modified, extract: destination }), /migration/);
          assert.equal(fs.existsSync(destination), false);
        }
        const appended = structuredClone(manifests[artifact.name]);
        const sql = Buffer.from("CREATE TABLE release_upgrade_control (id TEXT);\n");
        appended.migration_files.push({ name: "migrations/9999_future.sql", digest: `sha256:${sha256(sql)}` });
        fs.writeFileSync(path.join(repack, "migrations/9999_future.sql"), sql);
        fs.writeFileSync(path.join(repack, "artifact-manifest.json"), stableJson(appended));
        const changed = gzipSync(run("tar", ["--format=ustar", "-cf", "-", "-C", repack, ...fs.readdirSync(repack)]));
        fs.writeFileSync(archive, changed);
        const modified = structuredClone(record);
        modified.artifacts.find((entry) => entry.name === artifact.name).digest = `sha256:${sha256(changed)}`;
        assert.doesNotThrow(() => verifyComposition({ ...inputs, record: modified, previous: manifests }));
      } finally { fs.writeFileSync(archive, original); }
    });

    await t.test("extracted Worker boots with real D1/SQLite DO and retains state across runtime restart", async () => {
      const require = createRequire(fs.realpathSync(path.join(repositoryRoot, "services/communicator/apps/control-plane/node_modules/wrangler/package.json")));
      const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
      const workerRoot = path.join(extracted, "communicator-control-plane");
      const persist = path.join(temporary, "persist");
      const options = () => convertV4MiniflareOptions({
        resourcePersistencePath: persist,
        modules: true, modulesRoot: workerRoot, scriptPath: path.join(workerRoot, "worker.js"),
        compatibilityDate: "2026-08-27", compatibilityFlags: ["nodejs_compat"],
        durableObjects: { TENANT_PROJECTION: { className: "TenantProjectionDO", useSQLite: true }, LINK_SESSIONS: { className: "LinkSessionDO", useSQLite: true } },
        d1Databases: { CONTROL_DB: "control" },
        r2Buckets: ["EVENT_ARCHIVE"], bindings: { COMMUNICATOR_DATA_MODE: "live" },
      });
      const tenant = "tenant_release_isolation";
      const authorization = { schema_version: 1, tenant_id: tenant, principal_id: "principal_release", allowed_identity_ids: [], scopes: ["projection.initialize", "projection.status"] };
      let runtime = new Miniflare(options());
      let initialized;
      try {
        await runtime.ready;
        const response = await runtime.dispatchFetch("http://localhost/api/v1/health");
        assert.deepEqual(await response.json(), { status: "ok", service: "communicator-control-plane", data_mode: "live" });
        for (const route of ["oauth-protected-resource", "oauth-protected-resource/mcp", "oauth-authorization-server"]) {
          assert.equal((await runtime.dispatchFetch(`http://localhost/.well-known/${route}`)).status, 503, "incomplete browser configuration cannot enable the retired issuer");
        }
        const database = await runtime.getD1Database("CONTROL_DB");
        const { unstable_splitSqlQuery } = require("wrangler");
        for (const migration of manifests["communicator-control-plane"].migration_files) {
          const queries = unstable_splitSqlQuery(fs.readFileSync(path.join(workerRoot, migration.name), "utf8"));
          await database.batch(queries.map((query) => database.prepare(query)));
        }
        assert.ok(await database.prepare("SELECT name FROM sqlite_master WHERE name = 'platform_bindings'").first());
        await database.prepare("INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").bind(tenant, "release-proof", "Preserved release state", "2026-11-07T00:00:00.000Z", "2026-11-07T00:00:00.000Z").run();
        const namespace = await runtime.getDurableObjectNamespace("TENANT_PROJECTION");
        initialized = JSON.parse(JSON.stringify(await namespace.get(namespace.idFromName(tenant)).initialize({ schema_version: 1, tenant_id: tenant, initialized_at: "2026-11-07T00:00:00.000Z", authorization })));
      } finally { await runtime.dispose(); }
      runtime = new Miniflare(options());
      try {
        await runtime.ready;
        const database = await runtime.getD1Database("CONTROL_DB");
        assert.equal((await database.prepare("SELECT display_name FROM tenants WHERE id = ?").bind(tenant).first()).display_name, "Preserved release state");
        const namespace = await runtime.getDurableObjectNamespace("TENANT_PROJECTION");
        const resumed = await namespace.get(namespace.idFromName(tenant)).getStatus({ schema_version: 1, tenant_id: tenant, authorization });
        assert.deepEqual(JSON.parse(JSON.stringify(resumed)), initialized);
      } finally { await runtime.dispose(); }
    });

    await t.test("extracted MCP discovery and resource authorization follow the standalone Platform contract", async () => {
      const require = createRequire(fs.realpathSync(path.join(repositoryRoot, "services/communicator/apps/control-plane/node_modules/wrangler/package.json")));
      const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
      const workerRoot = path.join(extracted, "communicator-control-plane");
      // Reserved local names prove a relocatable contract, not public DNS or routing.
      const origin = "https://communicator.release.invalid";
      const platform = "https://platform.release.invalid";
      const principal = {
        version: 1, kind: "human", authority: "release-authority", audience: origin,
        subjectId: "release-user", organizationId: "release-org", membershipId: "release-membership",
        credentialId: "release-credential", capabilities: ["conversation.read"],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      let verification = { status: "authenticated", principal };
      let authorityStatus = 200;
      const runtime = new Miniflare(convertV4MiniflareOptions({
        modules: true, modulesRoot: workerRoot, scriptPath: path.join(workerRoot, "worker.js"),
        compatibilityDate: "2026-08-27", compatibilityFlags: ["nodejs_compat"],
        durableObjects: { TENANT_PROJECTION: { className: "TenantProjectionDO", useSQLite: true }, LINK_SESSIONS: { className: "LinkSessionDO", useSQLite: true } },
        d1Databases: { CONTROL_DB: "discovery" }, r2Buckets: ["EVENT_ARCHIVE"],
        bindings: {
          COMMUNICATOR_DATA_MODE: "live", COMMUNICATOR_PLATFORM_BASE_URL: platform,
          COMMUNICATOR_PLATFORM_AUTHORITY: principal.authority, COMMUNICATOR_PLATFORM_AUDIENCE: origin,
          COMMUNICATOR_PLATFORM_SERVICE_VERIFIER: "synthetic-service-verifier",
          COMMUNICATOR_PLATFORM_BROWSER_CLIENT_ID: "synthetic-client",
          COMMUNICATOR_PLATFORM_BROWSER_CLIENT_SECRET: "synthetic-client-secret",
          COMMUNICATOR_PLATFORM_BROWSER_REDIRECT_URI: `${origin}/auth/callback`,
          COMMUNICATOR_PLATFORM_BROWSER_RESOURCE: origin,
          COMMUNICATOR_PLATFORM_BROWSER_SCOPES: "conversation.read directory.read",
        },
        outboundService: async (request) => {
          assert.equal(request.url, `${platform}/internal/v1/authenticate`, "no uncontrolled network request");
          assert.equal(request.headers.get("authorization"), "Bearer synthetic-service-verifier");
          assert.deepEqual(await request.json(), { credential: "synthetic-user-token" });
          return Response.json(verification, { status: authorityStatus });
        },
      }));
      const get = (route, headers) => runtime.dispatchFetch(`${origin}${route}`, { headers });
      const mcp = (method, params = {}, headers = {}) => runtime.dispatchFetch(`${origin}/mcp`, {
        method: "POST", headers: { Authorization: "Bearer synthetic-user-token", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      try {
        await runtime.ready;
        const metadata = { resource: origin, authorization_servers: [platform], scopes_supported: ["conversation.read", "directory.read"], resource_documentation: `${origin}/api/v1/openapi.json` };
        for (const route of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
          const response = await get(route);
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), metadata);
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
        const discovery = await get("/.well-known/oauth-authorization-server");
        assert.deepEqual(await discovery.json(), { issuer: platform, authorization_endpoint: `${platform}/api/auth/oauth2/authorize`, token_endpoint: `${platform}/api/auth/oauth2/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], scopes_supported: metadata.scopes_supported });
        const unauthenticated = await get("/mcp");
        assert.equal(unauthenticated.status, 401);
        assert.equal(unauthenticated.headers.get("www-authenticate"), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
        const retired = await runtime.dispatchFetch(`${origin}/oauth/token`, { method: "POST" });
        assert.equal(retired.status, 503);

        const database = await runtime.getD1Database("CONTROL_DB");
        const { unstable_splitSqlQuery } = require("wrangler");
        for (const migration of manifests["communicator-control-plane"].migration_files) {
          await database.batch(unstable_splitSqlQuery(fs.readFileSync(path.join(workerRoot, migration.name), "utf8")).map((query) => database.prepare(query)));
        }
        const timestamp = "2026-11-07T00:00:00.000Z";
        await database.batch([
          database.prepare("INSERT INTO tenants VALUES ('tenant_release', 'release', 'Release', 'active', ?, ?)").bind(timestamp, timestamp),
          database.prepare("INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES ('principal_release', ?, 'release-user', 'human', 'Release', 'active', ?, ?)").bind(platform, timestamp, timestamp),
          database.prepare("INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES ('membership_release', 'tenant_release', 'principal_release', 'member', 'active', ?, ?)").bind(timestamp, timestamp),
          database.prepare("INSERT INTO platform_bindings (binding_id, platform_authority, platform_kind, platform_subject_id, platform_organization_id, platform_membership_id, local_tenant_id, local_principal_id, local_membership_id, status, created_at, updated_at) VALUES ('binding_release', ?, 'human', 'release-user', 'release-org', 'release-membership', 'tenant_release', 'principal_release', 'membership_release', 'active', ?, ?)").bind(principal.authority, timestamp, timestamp),
        ]);
        const initialized = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "release-consumer", version: "1" } });
        const initializedBody = await initialized.json();
        assert.equal(initialized.status, 200, JSON.stringify(initializedBody));
        assert.equal(initializedBody.result.serverInfo.name, "communicator");
        const tools = await mcp("tools/list");
        assert.ok((await tools.json()).result.tools.some((tool) => tool.name === "list_accounts"));
        assert.equal((await mcp("tools/list", {}, { Origin: "https://other.release.invalid" })).status, 403);
        const authenticatedGet = await get("/mcp", { Authorization: "Bearer synthetic-user-token" });
        assert.equal(authenticatedGet.status, 405);
        assert.equal(authenticatedGet.headers.get("allow"), "POST");
        assert.equal((await get("/api/v1/accounts", { Authorization: "Bearer synthetic-user-token" })).status, 403);
        assert.equal((await (await mcp("tools/call", { name: "list_accounts", arguments: {} })).json()).result.isError, true);
        verification = { status: "authenticated", principal: { ...principal, capabilities: ["directory.read"] } };
        const allowed = await (await mcp("tools/call", { name: "list_accounts", arguments: {} })).json();
        assert.notEqual(allowed.result.isError, true);
        assert.deepEqual(allowed.result.structuredContent, { items: [], next_cursor: null });
        for (const changed of [{ authority: "wrong-authority" }, { audience: `${origin}/mcp` }, { expiresAt: "2000-01-01T00:00:00.000Z" }]) {
          verification = { status: "authenticated", principal: { ...principal, ...changed } };
          assert.equal((await mcp("tools/list")).status, 503, "mismatched or expired authority response fails closed");
        }
        verification = { status: "authenticated", principal: { ...principal, subjectId: "unbound-user" } };
        assert.equal((await mcp("tools/list")).status, 404, "valid Platform credentials cannot create local bindings");
        verification = { status: "invalid_credential" };
        authorityStatus = 401;
        assert.equal((await mcp("tools/list")).status, 401);
      } finally { await runtime.dispose(); }
    });

    await t.test("native artifact runs without Cargo or source and retains protected-config stop semantics", () => {
      const native = path.join(extracted, "communicator-matrix-gateway/communicator-matrix-gateway");
      const result = spawnSync(native, ["run", "--config", path.join(temporary, "nonexistent.json")], { cwd: temporary, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
      assert.equal(result.status, 78);
      assert.match(result.stderr, /config_invalid|secret_/);
      assert.equal(fs.existsSync(path.join(extracted, "Cargo.toml")), false);
      const key = path.join(temporary, "test-state-key");
      const state = path.join(temporary, "native-state.sqlite");
      fs.writeFileSync(key, randomBytes(32).toString("base64"), { mode: 0o600 });
      const args = ["quarantine", "status", "--state-db", state, "--state-key-file", key];
      const expected = { schema_version: 1, status: "clear", pending_batches: 0, pending_bytes: 0, quarantined_windows: 0 };
      assert.deepEqual(JSON.parse(run(native, args, { cwd: temporary })), expected);
      assert.ok(fs.statSync(state).size > 0);
      assert.deepEqual(JSON.parse(run(native, args, { cwd: temporary })), expected);
    });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
