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

test("release configuration activates only the Msg Worker", () => {
  assert.doesNotThrow(() => assertReleaseConfig(config));
  assert.deepEqual(config.units.map((unit) => unit.name), ["msg-worker"]);

  const msg = config.units[0];
  assert.equal(msg.kind, "cloudflare-worker-bundle");
  assert.deepEqual(msg.build, {
    type: "cloudflare-worker",
    config_path: "services/msg/wrangler.jsonc",
    entrypoint: "worker.js",
    generated_entrypoint: "worker-entry.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    compatibility_date: "2026-08-09",
    compatibility_flags: ["nodejs_compat"],
    wrapper: "services/msg/scripts/wrangler-config.ts",
    assets: {
      source: "services/msg/worker/public",
      directory: "assets",
      binding: "ASSETS",
      run_worker_first: true
    },
    migrations: {
      source: "services/msg/worker/migrations",
      directory: "migrations"
    },
    wrangler: {
      durable_objects: {
        bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }]
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ConversationRoom"] }],
      d1_databases: [
        {
          binding: "MSG_DB",
          database_name: "0000-msg-operations",
          migrations_dir: "migrations"
        }
      ],
      secrets: {
        required: [
          "MSG_DATA_ENCRYPTION_KEY_V1",
          "MSG_OPERATOR_TOKEN",
          "MSG_VAPID_PUBLIC_KEY",
          "MSG_VAPID_PRIVATE_KEY",
          "MSG_VAPID_SUBJECT"
        ]
      },
      observability: { enabled: true, head_sampling_rate: 1 }
    },
    runtime: {
      rate_limits: [
        { name: "MSG_RATE_LIMIT_CREATION", simple: { limit: 6, period: 60 } },
        { name: "MSG_RATE_LIMIT_READS", simple: { limit: 60, period: 60 } },
        { name: "MSG_RATE_LIMIT_POSTS", simple: { limit: 20, period: 60 } },
        { name: "MSG_RATE_LIMIT_LIVE", simple: { limit: 10, period: 60 } }
      ],
      triggers: { crons: ["17 3 * * *"] }
    }
  });
  assert.equal(msg.archive_paths.some((entry) => /cli|sdk|cloud/i.test(entry)), false);
});

test("Msg bundle manifest carries only public deployment metadata", () => {
  const msg = config.units[0];
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
    durable_objects: {
      bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }]
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ConversationRoom"] }],
    d1_databases: [
      { binding: "MSG_DB", database_name: "0000-msg-operations", migrations_dir: "migrations" }
    ],
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
  assert.deepEqual(migrationMetadata(directory, fs.readdirSync(directory)), [
    {
      name: "migrations/0001_operations.sql",
      digest: "sha256:b7e5aa7e3dc060cc4a0737ad8167a8ae7a1e4b8d7242559150a058ce8309d67a"
    },
    {
      name: "migrations/0002_operations_retention.sql",
      digest: "sha256:f4c1ca7d78d230806a4c21809bc2290fbaf54ff85f414f0f616392c0c3df3372"
    },
    {
      name: "migrations/0003_creation_plan.sql",
      digest: "sha256:33933dda69e77a7f570c15c9d3f8b9d62be98a1378faefd1d0a3489bf81aad2c"
    }
  ]);
});

test("neutral Wrangler config excludes environment-owned values", () => {
  const neutral = neutralWranglerConfig(config.units[0]);

  assert.deepEqual(neutral, {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: "worker.js",
    compatibility_date: "2026-08-09",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    durable_objects: {
      bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }]
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ConversationRoom"] }],
    secrets: {
      required: [
        "MSG_DATA_ENCRYPTION_KEY_V1",
        "MSG_OPERATOR_TOKEN",
        "MSG_VAPID_PUBLIC_KEY",
        "MSG_VAPID_PRIVATE_KEY",
        "MSG_VAPID_SUBJECT"
      ]
    },
    observability: { enabled: true, head_sampling_rate: 1 },
    assets: { binding: "ASSETS", directory: "assets", run_worker_first: true },
    d1_databases: [
      { binding: "MSG_DB", database_name: "0000-msg-operations", migrations_dir: "migrations" }
    ],
    triggers: { crons: ["17 3 * * *"] }
  });
  assert.equal("name" in neutral, false);
  assert.equal("routes" in neutral, false);
  assert.equal("database_id" in neutral, false);
  assert.equal("ratelimits" in neutral, false);
  assert.equal("vars" in neutral, false);
});

test("Msg and root changes select only the Msg release unit", () => {
  assert.deepEqual(
    affectedUnits(config, ["services/msg/worker/src/worker.ts", "services/msg/worker/test/health.test.ts"])
      .map((unit) => unit.name),
    ["msg-worker"]
  );
  assert.deepEqual(affectedUnits(config, ["services/msg/cli/src/cli.ts"]), []);
  assert.deepEqual(affectedUnits(config, ["services/gateway/src/worker.ts"]), []);
  assert.deepEqual(affectedUnits(config, ["bun.lock"]).map((unit) => unit.name), ["msg-worker"]);
});

test("documentation-only changes create no artifact or runtime redeployment", () => {
  const changed = ["README.md", "docs/release-artifacts.md", "services/msg/docs/README.md"];
  assert.deepEqual(affectedUnits(config, changed), []);
  assert.equal(classifyChanges(changed, []), "documentation");
  const plan = makePlan({ config, base: head, head, changedFiles: changed });
  assert.equal(plan.runtime_redeployment, false);
  assert.deepEqual(plan.affected_units, []);
  assert.deepEqual(plan.artifacts, []);
});

test("validation-only service changes create a record without Cloud dispatch", () => {
  for (const changedFile of [
    "services/brain/0000-product.json",
    "services/platform/scripts/check",
    "services/database/package.json",
    "services/platform/docs/README.md"
  ]) {
    const plan = makePlan({ config, base: head, head, changedFiles: [changedFile] });
    assert.equal(plan.change_class, changedFile.endsWith("README.md") ? "documentation" : "non-runtime");
    assert.equal(plan.runtime_redeployment, false);
    assert.deepEqual(plan.affected_units, []);
    assert.deepEqual(plan.artifacts, []);
  }
});

test("unmapped scaffold and app runtime changes fail closed", () => {
  for (const service of ["platform", "database", "brain"]) {
    for (const runtimePath of ["src/index.ts", "config/runtime.json", "migrations/0001_init.sql"]) {
      assert.throws(
        () => makePlan({ config, base: head, head, changedFiles: [`services/${service}/${runtimePath}`] }),
        /unmapped runtime changes require an explicit release unit before merge/
      );
    }
  }
  assert.throws(
    () => makePlan({ config, base: head, head, changedFiles: ["apps/0000/src/index.ts"] }),
    /unmapped runtime changes require an explicit release unit before merge/
  );
});

test("release workflow uses scoped App credentials and dispatches only runtime plans", () => {
  assert.match(releaseWorkflow, /group: public-release-\$\{\{ github\.sha \}\}/);
  assert.match(releaseWorkflow, /actions\/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3 # v3\.1\.1/);
  assert.match(releaseWorkflow, /PUBLIC_RELEASE_APP_CLIENT_ID/);
  assert.match(releaseWorkflow, /CLOUD_RELEASE_APP_CLIENT_ID/);
  assert.match(releaseWorkflow, /repositories: \$\{\{ steps\.cloud-target\.outputs\.repository \}\}/);
  assert.match(releaseWorkflow, /permission-workflows: write/);
  assert.match(releaseWorkflow, /permission-administration: read/);
  assert.match(releaseWorkflow, /permission-actions: write/);
  assert.doesNotMatch(releaseWorkflow, /CLOUD_RELEASE_DISPATCH_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /CLOUDFLARE_API_TOKEN|PHASE_SERVICE_TOKEN/);
  assert.match(releaseWorkflow, /--draft/);
  assert.match(releaseWorkflow, /--draft=false/);
  assert.match(releaseWorkflow, /retry-provenance/);
  assert.match(releaseWorkflow, /github\.run_attempt/);
  assert.match(releaseWorkflow, /immutable releases must be enabled/);
  assert.match(releaseWorkflow, /if: steps\.plan\.outputs\.runtime_redeployment == 'true'/);
});

test("legacy Gateway production fallback remains manual and owner-confirmed", () => {
  assert.match(legacyGatewayWorkflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(legacyGatewayWorkflow, /(^|\n)  push:/);
  assert.match(legacyGatewayWorkflow, /^      confirm_production_deploy:\s*$/m);
  assert.match(legacyGatewayWorkflow, /required:\s*true/);
  assert.match(
    legacyGatewayWorkflow,
    /github\.actor == 'donmasakayan' && github\.triggering_actor == 'donmasakayan' && inputs\.confirm_production_deploy == 'DEPLOY_GATEWAY'/
  );
});

test("release version is deterministic and uses the exact public main SHA", () => {
  assert.equal(releaseVersion(head), `v0.0.0-${head}`);
  assert.match(releaseVersion(head), /^v?[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{40}$/);
});

test("release records retain exact Msg artifact and Cloud selection", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/worker/src/worker.ts"] });
  const digest = `sha256:${"d".repeat(64)}`;
  const record = createReleaseRecord(plan, [{
    name: "msg-worker",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    asset_name: "msg-worker-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: config.units[0].archive_paths,
    artifact_format: "0000-cloudflare-worker-bundle-v1",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    directories: ["assets", "migrations"],
    migration_files: [
      { name: "migrations/0001_operations.sql", digest: `sha256:${"a".repeat(64)}` }
    ],
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
        `Msg Worker staging ${plan.release_version}`
      ]
    }
  }]);
  assert.equal(record.release.source.commit, head);
  assert.equal(record.artifacts[0].source_commit, head);
  assert.deepEqual(record.cloud_selection.artifacts, [{
    name: "msg-worker",
    version: plan.release_version,
    digest,
    compatibility: config.release.compatibility,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    asset_name: "msg-worker-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz"
  }]);
  assert.deepEqual(record.artifacts[0].migration_files, [
    { name: "migrations/0001_operations.sql", digest: `sha256:${"a".repeat(64)}` }
  ]);
  assert.equal(record.publication_policy.production_deployment, false);
});

test("Cloud event carries exact Msg artifact and attestation provenance", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/worker/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "msg-worker",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    asset_name: "msg-worker-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest: `sha256:${"b".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: config.units[0].archive_paths
  }]);
  assert.deepEqual(createReleaseEvent(plan, record, {
    workflow: "release",
    run_id: "123",
    workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/123",
    attestation: "https://github.com/0000-chat/0000/attestations/456"
  }).release, {
    version: plan.release_version,
    commit: head,
    artifacts: [{
      name: "msg-worker",
      version: plan.release_version,
      digest: `sha256:${"b".repeat(64)}`,
      compatibility: config.release.compatibility,
      kind: "cloudflare-worker-bundle",
      media_type: "application/gzip",
      asset_name: "msg-worker-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz"
    }],
    provenance: {
      workflow: "release",
      run_id: "123",
      workflow_run_url: "https://github.com/0000-chat/0000/actions/runs/123",
      attestation: "https://github.com/0000-chat/0000/attestations/456"
    }
  });
});

test("docs-only event carries provenance and no artifacts", () => {
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
});

test("runtime event cannot substitute a workflow URL for attestation", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/worker/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "msg-worker",
    version: plan.release_version,
    kind: "cloudflare-worker-bundle",
    media_type: "application/gzip",
    asset_name: "msg-worker-v0.0.0-0123456789abcdef0123456789abcdef01234567.tar.gz",
    digest: `sha256:${"c".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: config.units[0].archive_paths
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
