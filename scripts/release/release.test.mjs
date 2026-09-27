import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  affectedUnits,
  assertReleaseConfig,
  classifyChanges,
  makePlan,
  readReleaseConfig,
  releaseVersion
} from "./lib.mjs";
import { createReleaseEvent } from "./event.mjs";
import { createReleaseRecord } from "./record.mjs";
import { neutralWranglerConfig, workerArtifactManifest } from "./worker.mjs";
import { migrationMetadata } from "./migrations.mjs";

const config = readReleaseConfig();
const head = "0123456789abcdef0123456789abcdef01234567";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const legacyGatewayWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-gateway.yml"), "utf8");

test("release unit configuration is valid and excludes private or non-runtime publications", () => {
  assert.doesNotThrow(() => assertReleaseConfig(config));
  const names = config.units.map((unit) => unit.name);
  assert.deepEqual(names, [
    "gateway",
    "streams",
    "msg-worker",
    "communicator-control-plane",
    "communicator-matrix-gateway"
  ]);
  assert.equal(names.some((name) => /sdk|cli|cloud/i.test(name)), false);
  assert.equal(config.units.some((unit) => unit.archive_paths.some((entry) => /sdk|cli|cloud/i.test(entry))), false);
  const gateway = config.units.find((unit) => unit.name === "gateway");
  assert.equal(gateway.kind, "cloudflare-worker-bundle");
  assert.deepEqual(gateway.build, {
    type: "cloudflare-worker",
    config_path: "services/gateway/wrangler.jsonc",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    compatibility_date: "2026-08-06",
    compatibility_flags: ["nodejs_compat"]
  });
  const msg = config.units.find((unit) => unit.name === "msg-worker");
  assert.equal(msg.kind, "cloudflare-worker-bundle");
  assert.equal(msg.build.generated_entrypoint, "worker-entry.js");
  assert.deepEqual(msg.build.assets, {
    source: "services/msg/worker/public",
    directory: "assets",
    binding: "ASSETS",
    run_worker_first: true
  });
  assert.deepEqual(msg.build.migrations, {
    source: "services/msg/worker/migrations",
    directory: "migrations"
  });
  assert.deepEqual(msg.build.wrangler.durable_objects, {
    bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }]
  });
  assert.deepEqual(msg.build.wrangler.migrations, [
    { tag: "v1", new_sqlite_classes: ["ConversationRoom"] }
  ]);
  assert.deepEqual(msg.build.wrangler.d1_databases, [
    { binding: "MSG_DB", database_name: "0000-msg-operations", migrations_dir: "migrations" }
  ]);
  assert.deepEqual(msg.build.runtime, {
    rate_limits: [
      { name: "MSG_RATE_LIMIT_CREATION", simple: { limit: 6, period: 60 } },
      { name: "MSG_RATE_LIMIT_READS", simple: { limit: 60, period: 60 } },
      { name: "MSG_RATE_LIMIT_POSTS", simple: { limit: 20, period: 60 } },
      { name: "MSG_RATE_LIMIT_LIVE", simple: { limit: 10, period: 60 } }
    ],
    triggers: { crons: ["17 3 * * *"] }
  });
});

test("Gateway bundle manifest matches the Cloud staging contract exactly", () => {
  const gateway = config.units.find((unit) => unit.name === "gateway");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  assert.deepEqual(workerArtifactManifest(gateway, plan), {
    schema_version: 1,
    product: "0000",
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    source_commit: head,
    compatibility: { api: "v1", config: "v1" },
    entrypoint: "worker.js",
    compatibility_date: "2026-08-06",
    compatibility_flags: ["nodejs_compat"]
  });
});

test("Msg bundle manifest carries static asset, D1, and Durable Object metadata", () => {
  const msg = config.units.find((unit) => unit.name === "msg-worker");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/worker/src/worker.ts"] });
  assert.deepEqual(workerArtifactManifest(msg, plan), {
    schema_version: 1,
    product: "0000",
    name: "msg-worker",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    source_commit: head,
    compatibility: { api: "v1", config: "v1" },
    entrypoint: "worker.js",
    compatibility_date: "2026-08-09",
    compatibility_flags: ["nodejs_compat"],
    assets: { binding: "ASSETS", directory: "assets", run_worker_first: true },
    durable_objects: { bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ConversationRoom"] }],
    d1_databases: [{ binding: "MSG_DB", database_name: "0000-msg-operations", migrations_dir: "migrations" }],
    required_secrets: [
      "MSG_DATA_ENCRYPTION_KEY_V1",
      "MSG_OPERATOR_TOKEN",
      "MSG_VAPID_PUBLIC_KEY",
      "MSG_VAPID_PRIVATE_KEY",
      "MSG_VAPID_SUBJECT"
    ],
    observability: { enabled: true, head_sampling_rate: 1 },
    rate_limits: [
      { name: "MSG_RATE_LIMIT_CREATION", simple: { limit: 6, period: 60 } },
      { name: "MSG_RATE_LIMIT_READS", simple: { limit: 60, period: 60 } },
      { name: "MSG_RATE_LIMIT_POSTS", simple: { limit: 20, period: 60 } },
      { name: "MSG_RATE_LIMIT_LIVE", simple: { limit: 10, period: 60 } }
    ],
    triggers: { crons: ["17 3 * * *"] }
  });
});

test("Msg D1 migration metadata is ordered and content-addressed", () => {
  const directory = path.join(repositoryRoot, "services/msg/worker/migrations");
  const files = fs.readdirSync(directory);
  assert.deepEqual(migrationMetadata(directory, files), [
    { name: "migrations/0001_operations.sql", digest: "sha256:b7e5aa7e3dc060cc4a0737ad8167a8ae7a1e4b8d7242559150a058ce8309d67a" },
    { name: "migrations/0002_operations_retention.sql", digest: "sha256:f4c1ca7d78d230806a4c21809bc2290fbaf54ff85f414f0f616392c0c3df3372" },
    { name: "migrations/0003_creation_plan.sql", digest: "sha256:33933dda69e77a7f570c15c9d3f8b9d62be98a1378faefd1d0a3489bf81aad2c" }
  ]);
});

test("Msg neutral Wrangler config retains the cron trigger without environment-owned rate-limit IDs", () => {
  const msg = config.units.find((unit) => unit.name === "msg-worker");
  const neutral = neutralWranglerConfig(msg);
  assert.deepEqual(neutral.triggers, { crons: ["17 3 * * *"] });
  assert.equal("ratelimits" in neutral, false);
});

test("documentation-only changes create no runtime redeployment", () => {
  const changed = ["README.md", "docs/release-artifacts.md", "services/gateway/docs/README.md"];
  assert.deepEqual(affectedUnits(config, changed), []);
  assert.equal(classifyChanges(changed, []), "documentation");
  const plan = makePlan({ config, base: head, head, changedFiles: changed });
  assert.equal(plan.runtime_redeployment, false);
  assert.deepEqual(plan.affected_units, []);
  assert.deepEqual(plan.artifacts, []);
});

test("validation-only service changes still publish a record without Cloud dispatch", () => {
  for (const changedFile of [
    "services/brain/src/worker.ts",
    "services/platform/src/index.ts",
    "services/database/src/index.ts"
  ]) {
    const plan = makePlan({ config, base: head, head, changedFiles: [changedFile] });
    assert.equal(plan.change_class, "non-runtime");
    assert.equal(plan.runtime_redeployment, false);
    assert.deepEqual(plan.affected_units, []);
    assert.deepEqual(plan.artifacts, []);
  }
});

test("release workflow keeps every source SHA and protects the draft-to-immutable transition", () => {
  assert.match(releaseWorkflow, /group: public-release-\$\{\{ github\.sha \}\}/);
  assert.match(releaseWorkflow, /actions\/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3\.1\.1/);
  assert.match(releaseWorkflow, /PUBLIC_RELEASE_APP_CLIENT_ID/);
  assert.match(releaseWorkflow, /CLOUD_RELEASE_APP_CLIENT_ID/);
  assert.match(releaseWorkflow, /repositories: \$\{\{ steps\.cloud-target\.outputs\.repository \}\}/);
  assert.match(releaseWorkflow, /permission-workflows: write/);
  assert.match(releaseWorkflow, /permission-administration: read/);
  assert.match(releaseWorkflow, /permission-actions: write/);
  assert.doesNotMatch(releaseWorkflow, /CLOUD_RELEASE_DISPATCH_TOKEN/);
  assert.match(releaseWorkflow, /--draft/);
  assert.match(releaseWorkflow, /--draft=false/);
  assert.match(releaseWorkflow, /retry-provenance/);
  assert.match(releaseWorkflow, /github\.run_attempt/);
  assert.match(releaseWorkflow, /immutable releases must be enabled/);
  assert.match(releaseWorkflow, /if: steps\.plan\.outputs\.runtime_redeployment == 'true'/);
});

test("Gateway production fallback is manual and owner-confirmed", () => {
  assert.match(legacyGatewayWorkflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(legacyGatewayWorkflow, /(^|\n)  push:/);
  assert.match(legacyGatewayWorkflow, /^      confirm_production_deploy:\s*$/m);
  assert.match(legacyGatewayWorkflow, /required:\s*true/);
  assert.match(
    legacyGatewayWorkflow,
    /github\.actor == 'donmasakayan' && github\.triggering_actor == 'donmasakayan' && inputs\.confirm_production_deploy == 'DEPLOY_GATEWAY'/
  );
});

test("a Worker change only selects its deployable unit", () => {
  assert.deepEqual(
    affectedUnits(config, ["services/gateway/src/worker.ts", "services/gateway/test/health.test.ts"])
      .map((unit) => unit.name),
    ["gateway"]
  );
  assert.deepEqual(affectedUnits(config, ["services/msg/cli/src/cli.ts"]), []);
});

test("shared root inputs conservatively select all runtime units", () => {
  assert.deepEqual(
    affectedUnits(config, ["bun.lock"]).map((unit) => unit.name),
    config.units.map((unit) => unit.name).sort()
  );
});

test("the release version is deterministic and matches the Cloud semver contract", () => {
  assert.equal(releaseVersion(head), `v0.0.0-${head}`);
  assert.match(releaseVersion(head), /^v?[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{40}$/);
});

test("release records expose the exact digest selection Cloud can pin", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  const digest = `sha256:${"a".repeat(64)}`;
  const record = createReleaseRecord(plan, [{
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-source",
    media_type: "application/gzip",
    asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: ["services/gateway/src"]
  }]);
  assert.equal(record.release.source.commit, head);
  assert.deepEqual(record.cloud_selection.artifacts, [{
    name: "gateway",
    version: plan.release_version,
    digest,
    compatibility: config.release.compatibility,
    kind: "cloudflare-worker-source",
    media_type: "application/gzip",
    asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz"
  }]);
  assert.equal(record.publication_policy.production_deployment, false);
});

test("release records retain the prebuilt Worker deployment contract", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest: `sha256:${"d".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: ["services/gateway/src"],
    artifact_format: "0000-cloudflare-worker-bundle-v1",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    entrypoint_digest: `sha256:${"e".repeat(64)}`,
    deployment: {
      tool: "wrangler",
      mode: "prebuilt",
      route_configuration: "cloud",
      command: [
        "wrangler",
        "deploy",
        "--config",
        "wrangler.staging.json",
        "--no-bundle",
        "--strict",
        "--message",
        `Gateway staging ${plan.release_version}`
      ]
    }
  }]);
  assert.equal(record.artifacts[0].artifact_format, "0000-cloudflare-worker-bundle-v1");
  assert.equal(record.artifacts[0].entrypoint, "worker.js");
  assert.equal(record.artifacts[0].deployment.route_configuration, "cloud");
  assert.deepEqual(record.artifacts[0].deployment.command, [
    "wrangler",
    "deploy",
    "--config",
    "wrangler.staging.json",
    "--no-bundle",
    "--strict",
    "--message",
    `Gateway staging ${plan.release_version}`
  ]);
  assert.equal(record.cloud_selection.artifacts[0].digest, `sha256:${"d".repeat(64)}`);
});

test("Cloud dispatch event uses the nested immutable release contract", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-source",
    media_type: "application/gzip",
    asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest: `sha256:${"b".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: ["services/gateway/src"]
  }]);
  assert.deepEqual(createReleaseEvent(plan, record, {
    workflow: "release",
    run_id: "123",
    workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/123",
    attestation: "https://github.com/0000-chat/0000/attestations/456"
  }), {
    schema_version: 1,
    product: "0000",
    source_repository: "0000-chat/0000",
    release: {
      version: plan.release_version,
      commit: head,
      artifacts: [{
        name: "gateway",
        version: plan.release_version,
        digest: `sha256:${"b".repeat(64)}`,
        compatibility: config.release.compatibility,
        kind: "cloudflare-worker-source",
        media_type: "application/gzip",
        asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz"
      }],
      provenance: {
        workflow: "release",
        run_id: "123",
        workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/123",
        attestation: "https://github.com/0000-chat/0000/attestations/456"
      }
    },
    changed_paths: ["services/gateway/src/worker.ts"]
  });
});

test("docs-only Cloud dispatch still carries provenance and no artifacts", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["docs/release-artifacts.md"] });
  const record = createReleaseRecord(plan, []);
  const event = createReleaseEvent(plan, record, {
    workflow: "release",
    run_id: "124",
    workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/124"
  });
  assert.deepEqual(event.release.artifacts, []);
  assert.deepEqual(event.release.provenance, {
    workflow: "release",
    run_id: "124",
    workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/124"
  });
  assert.deepEqual(event.changed_paths, ["docs/release-artifacts.md"]);
});

test("runtime Cloud dispatch cannot substitute a workflow URL for attestation", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-source",
    media_type: "application/gzip",
    asset_name: "gateway-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest: `sha256:${"c".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: ["services/gateway/src"]
  }]);
  assert.throws(
    () => createReleaseEvent(plan, record, {
      workflow: "release",
      run_id: "125",
      workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/125"
    }),
    /provenance\.attestation is required/
  );
});
