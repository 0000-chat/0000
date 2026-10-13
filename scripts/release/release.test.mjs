import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  affectedUnits,
  assertReleaseConfig,
  assertWorkerBuildConfigMatchesSource,
  classifyChanges,
  makePlan,
  readReleaseConfig,
  readJsonc,
  releaseVersion,
  sha256
} from "./lib.mjs";
import { changedFiles, readBaseReleaseConfig } from "./plan.mjs";
import { createReleaseEvent } from "./event.mjs";
import { createReleaseRecord } from "./record.mjs";
import { neutralWranglerConfig, workerArtifactManifest } from "./worker.mjs";
import { assertAppendOnlyD1Migrations, migrationMetadata } from "./migrations.mjs";
import { copyGeneratedModules } from "./modules.mjs";

const config = readReleaseConfig();
const head = "0123456789abcdef0123456789abcdef01234567";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const legacyGatewayWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-gateway.yml"), "utf8");

test("release configuration activates Worker and Bun runtime units", () => {
  assert.doesNotThrow(() => assertReleaseConfig(config));
  assert.deepEqual(config.units.map((unit) => unit.name), ["msg-worker", "gateway", "database-worker", "platform-worker", "msg-webhook-dispatcher"]);

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
      rules: [
        { type: "Text", globs: ["**/*.svg"], fallthrough: true }
      ],
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
          "MSG_PLATFORM_SERVICE_VERIFIER",
          "MSG_PLATFORM_GUEST_GRANT_ISSUER",
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

  const gateway = config.units.find((unit) => unit.name === "gateway");
  assert.equal(gateway.kind, "cloudflare-worker-bundle");
  assert.deepEqual(gateway.runtime_paths, [
    "services/gateway/src/**",
    "services/gateway/package.json",
    "services/gateway/tsconfig.json",
    "services/gateway/tooling/pnpm-lock.yaml",
    "services/gateway/wrangler.jsonc"
  ]);
  assert.deepEqual(gateway.archive_paths, [
    "services/gateway/src",
    "services/gateway/package.json",
    "services/gateway/tsconfig.json",
    "services/gateway/wrangler.jsonc"
  ]);
  assert.deepEqual(gateway.build, {
    type: "cloudflare-worker",
    config_path: "services/gateway/wrangler.jsonc",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    compatibility_date: "2026-08-06",
    compatibility_flags: ["nodejs_compat"]
  });
  assert.doesNotThrow(() => assertWorkerBuildConfigMatchesSource(gateway, gateway.build, repositoryRoot));

  const database = config.units.find((unit) => unit.name === "database-worker");
  assert.equal(database.kind, "cloudflare-worker-bundle");
  assert.deepEqual(database.runtime_paths, [
    "services/database/src/**",
    "services/database/package.json",
    "services/database/tsconfig.json",
    "services/database/wrangler.jsonc"
  ]);
  assert.deepEqual(database.archive_paths, [
    "services/database/src",
    "services/database/package.json",
    "services/database/tsconfig.json",
    "services/database/wrangler.jsonc"
  ]);
  assert.deepEqual(database.build, {
    type: "cloudflare-worker",
    config_path: "services/database/wrangler.jsonc",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    compatibility_date: "2026-09-11",
    compatibility_flags: ["nodejs_compat"],
    wrangler: {
      durable_objects: {
        bindings: [
          { name: "DATABASES", class_name: "DatabaseObject" },
          { name: "REGISTRY", class_name: "DatabaseRegistry" }
        ]
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["DatabaseObject", "DatabaseRegistry"] }],
      observability: { enabled: false },
      vars: {
        CAPACITY_POLICY_REVISION: "1",
        CAPACITY_MAX_DATABASES: "32",
        CAPACITY_MAX_LOGICAL_BYTES: "536870912",
        CAPACITY_MAX_REPLAY_BYTES: "1073741824",
        CAPACITY_MAX_PHYSICAL_BYTES: "4294967296",
        CAPACITY_MAX_PHYSICAL_BYTES_PER_DATABASE: "134217728",
        CAPACITY_MAX_DAILY_REQUESTS: "50000",
        CAPACITY_MAX_REQUESTS_PER_MINUTE: "1000",
        CAPACITY_MAX_DAILY_MUTATIONS: "5000",
        CAPACITY_MAX_EXPORT_BYTES: "134217728",
        CAPACITY_MAX_CONTROL_BYTES: "67108864",
        SERVICE_SUSPENDED: "false"
      }
    }
  });
  assert.equal(database.archive_paths.some((entry) => /cli|sdk|cloud/i.test(entry)), false);
  assert.doesNotThrow(() => assertWorkerBuildConfigMatchesSource(database, database.build, repositoryRoot));

  const platform = config.units.find((unit) => unit.name === "platform-worker");
  assert.equal(platform.kind, "cloudflare-worker-bundle");
  assert.deepEqual(platform.runtime_paths, [
    "services/platform/src/**",
    "services/platform/migrations/**",
    "services/platform/package.json",
    "services/platform/wrangler.jsonc",
    "services/platform/scripts/wrangler-config.ts",
    "services/platform/scripts/provision-service.ts"
  ]);
  assert.deepEqual(platform.archive_paths, [
    "services/platform/src",
    "services/platform/migrations",
    "services/platform/package.json",
    "services/platform/wrangler.jsonc",
    "services/platform/scripts/wrangler-config.ts",
    "services/platform/scripts/provision-service.ts"
  ]);
  assert.deepEqual(platform.build, {
    type: "cloudflare-worker",
    config_path: "services/platform/wrangler.jsonc",
    entrypoint: "worker.js",
    generated_entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json", "provision-service.js"],
    compatibility_date: "2026-09-18",
    compatibility_flags: ["nodejs_compat"],
    wrapper: "services/platform/scripts/wrangler-config.ts",
    helpers: [
      { source: "services/platform/scripts/provision-service.ts", entrypoint: "provision-service.js" }
    ],
    migrations: { source: "services/platform/migrations", directory: "migrations" },
    wrangler: {
      d1_databases: [
        { binding: "IDENTITY_DB", database_name: "platform-identity", migrations_dir: "migrations" }
      ],
      secrets: {
        required: ["BETTER_AUTH_SECRET"],
        optional: ["GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"]
      }
    },
    runtime: {
      rate_limits: [
        { name: "PLATFORM_RATE_LIMIT_LOGIN", simple: { limit: 30, period: 60 } },
        { name: "PLATFORM_RATE_LIMIT_ISSUANCE", simple: { limit: 60, period: 60 } },
        { name: "PLATFORM_RATE_LIMIT_MANAGEMENT", simple: { limit: 60, period: 60 } },
        { name: "PLATFORM_RATE_LIMIT_VERIFICATION", simple: { limit: 600, period: 60 } },
        { name: "PLATFORM_RATE_LIMIT_GUEST_CONTROL", simple: { limit: 120, period: 60 } }
      ]
    }
  });
  assert.doesNotThrow(() => assertWorkerBuildConfigMatchesSource(platform, platform.build, repositoryRoot));

  const dispatcher = config.units.find((unit) => unit.name === "msg-webhook-dispatcher");
  assert.equal(dispatcher.kind, "bun-runtime-bundle");
  assert.deepEqual(dispatcher.runtime_paths, [
    "services/msg/scripts/mcp-webhook-dispatcher.ts",
    "services/msg/worker/src/mcp-webhook-transport.ts",
    "services/msg/package.json"
  ]);
  assert.deepEqual(dispatcher.archive_paths, dispatcher.runtime_paths);
  assert.deepEqual(dispatcher.build, {
    type: "bun-runtime",
    source: "services/msg/scripts/mcp-webhook-dispatcher.ts",
    entrypoint: "mcp-webhook-dispatcher.js",
    files: ["mcp-webhook-dispatcher.js", "artifact-manifest.json"],
    runtime: {
      engine: "bun",
      version: "1.3.14",
      command: ["bun", "mcp-webhook-dispatcher.js"],
      required_env: ["MSG_MCP_WEBHOOK_DISPATCH_TOKEN"],
      optional_env: [
        "MSG_MCP_WEBHOOK_DISPATCH_HOST",
        "MSG_MCP_WEBHOOK_DISPATCH_PORT",
        "MSG_MCP_WEBHOOK_DISPATCH_TLS_CERT_FILE",
        "MSG_MCP_WEBHOOK_DISPATCH_TLS_KEY_FILE",
        "MSG_MCP_WEBHOOK_DISPATCH_TRUSTED_INTERNAL_PROXY"
      ]
    }
  });
});

test("Bun dispatcher changes select only the dispatcher unit", () => {
  assert.deepEqual(
    affectedUnits(config, ["services/msg/scripts/mcp-webhook-dispatcher.ts"]).map((unit) => unit.name),
    ["msg-webhook-dispatcher"],
  );
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
    rules: [
      { type: "Text", globs: ["**/*.svg"], fallthrough: true }
    ],
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
      "MSG_PLATFORM_SERVICE_VERIFIER",
          "MSG_PLATFORM_GUEST_GRANT_ISSUER",
      "MSG_VAPID_PUBLIC_KEY",
      "MSG_VAPID_PRIVATE_KEY",
      "MSG_VAPID_SUBJECT"
    ],
    observability: { enabled: true, head_sampling_rate: 1 },
    modules: [],
    rate_limits: [
      { name: "MSG_RATE_LIMIT_CREATION", simple: { limit: 6, period: 60 } },
      { name: "MSG_RATE_LIMIT_READS", simple: { limit: 60, period: 60 } },
      { name: "MSG_RATE_LIMIT_POSTS", simple: { limit: 20, period: 60 } },
      { name: "MSG_RATE_LIMIT_LIVE", simple: { limit: 10, period: 60 } }
    ],
    triggers: { crons: ["17 3 * * *"] }
  });
});

test("Platform bundle carries neutral authority bindings and helper attestation", () => {
  const platform = config.units.find((unit) => unit.name === "platform-worker");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/platform/src/worker.ts"] });
  const helperDigest = `sha256:${"a".repeat(64)}`;
  const manifest = workerArtifactManifest(platform, plan, {
    helpers: [{ name: "provision-service.js", digest: helperDigest }],
  });
  assert.deepEqual(manifest.required_secrets, ["BETTER_AUTH_SECRET"]);
  assert.deepEqual(manifest.optional_secrets, ["GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"]);
  assert.deepEqual(manifest.helpers, [{ name: "provision-service.js", digest: helperDigest }]);
  assert.deepEqual(manifest.d1_databases, [
    { binding: "IDENTITY_DB", database_name: "platform-identity", migrations_dir: "migrations" },
  ]);
  assert.deepEqual(manifest.rate_limits, platform.build.runtime.rate_limits);
  assert.equal("vars" in manifest, false);

  const neutral = neutralWranglerConfig(platform);
  assert.deepEqual(neutral.secrets, { required: ["BETTER_AUTH_SECRET"] });
  assert.deepEqual(neutral.d1_databases, manifest.d1_databases);
  assert.equal("vars" in neutral, false);
  assert.equal(JSON.stringify(neutral).includes("database_id"), false);
  assert.equal(JSON.stringify(neutral).includes("namespace_id"), false);
  assert.equal(JSON.stringify(neutral).includes("GOOGLE_CLIENT"), false);
});

test("Gateway bundle manifest and Wrangler config leave route ownership to Cloud", () => {
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
  assert.deepEqual(neutralWranglerConfig(gateway), {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: "worker.js",
    compatibility_date: "2026-08-06",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false
  });
});

test("Database bundle manifest preserves public policy and SQLite DO deployment metadata", () => {
  const database = config.units.find((unit) => unit.name === "database-worker");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/database/src/worker.ts"] });
  const manifest = workerArtifactManifest(database, plan);
  const wrangler = neutralWranglerConfig(database);

  assert.deepEqual(manifest.durable_objects, database.build.wrangler.durable_objects);
  assert.deepEqual(manifest.migrations, database.build.wrangler.migrations);
  assert.deepEqual(manifest.vars, database.build.wrangler.vars);
  assert.deepEqual(wrangler.durable_objects, database.build.wrangler.durable_objects);
  assert.deepEqual(wrangler.migrations, database.build.wrangler.migrations);
  assert.deepEqual(wrangler.vars, database.build.wrangler.vars);
  assert.equal(manifest.name, "database-worker");
  assert.equal(manifest.required_secrets, undefined);
  assert.equal(JSON.stringify(manifest).includes("account_id"), false);
  assert.equal(JSON.stringify(manifest).includes("database.0000.chat"), false);
  assert.equal(JSON.stringify(manifest).includes("route"), false);
  assert.equal(JSON.stringify(manifest).includes("secret"), false);
});

test("Database public policy values reject missing, malformed, and environment-owned fields", () => {
  const database = config.units.find((unit) => unit.name === "database-worker");
  const invalidConfigs = [
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: { ...database.build.wrangler.vars, SERVICE_SUSPENDED: "enabled" },
        },
      },
    },
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: { ...database.build.wrangler.vars, CAPACITY_MAX_DATABASES: "0" },
        },
      },
    },
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: { ...database.build.wrangler.vars, CAPACITY_POLICY_REVISION: "01" },
        },
      },
    },
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: { ...database.build.wrangler.vars, CAPACITY_MAX_CONTROL_BYTES: "9007199254740992" },
        },
      },
    },
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: Object.fromEntries(
            Object.entries(database.build.wrangler.vars).filter(([name]) => name !== "CAPACITY_MAX_DATABASES"),
          ),
        },
      },
    },
    {
      ...database,
      build: {
        ...database.build,
        wrangler: {
          ...database.build.wrangler,
          vars: { ...database.build.wrangler.vars, CLOUDFLARE_ACCOUNT_ID: "123" },
        },
      },
    },
  ];

  for (const unit of invalidConfigs) {
    assert.throws(() =>
      assertReleaseConfig({
        ...config,
        units: config.units.map((candidate) => candidate.name === unit.name ? unit : candidate),
      }),
    );
  }
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
    },
    {
      name: "migrations/0005_mcp_oauth.sql",
      digest: "sha256:8a885a45b67809a491a3109c51a08f7048ff742ff7c7da654003e2f1b72fa369"
    }
  ]);
});

test("Platform D1 migration metadata is ordered and content-addressed", () => {
  const directory = path.join(repositoryRoot, "services/platform/migrations");
  assert.deepEqual(migrationMetadata(directory, fs.readdirSync(directory)), [
    { name: "migrations/0001_better_auth.sql", digest: "sha256:76db66e0712fa0d028a2d68a7c7135c5ed9ea9fdf021d480755af15fec029bda" },
    { name: "migrations/0002_platform_authority.sql", digest: "sha256:6c86953f078d68b4571aebeec47589565c52dba500ca5bf058e8b4de3af75d1f" },
    { name: "migrations/0003_organization_authority.sql", digest: "sha256:c3edcd26752b4f0e688603c6527ce43ef31f9e75190c1611cc6d10af7d4791d0" },
    { name: "migrations/0004_credential_lifecycle.sql", digest: "sha256:6245f3e83814e2e1415ceeb714a484f99fd03c6cc062adddcf8eb4b0b02e6f41" },
    { name: "migrations/0005_agent_authority.sql", digest: "sha256:20ff59f9dc1a2a8c33c8b08b67fff8853568bd0fb686ea3e02c620a31c14a858" },
    { name: "migrations/0006_social_signup_recovery.sql", digest: "sha256:617cf8e9638ae9cd2e6830c0a4a7eedc0e745e509d2d91ef98c1405addc14b45" },
    { name: "migrations/0007_guest_lifecycle.sql", digest: "sha256:f929beacc68cb04bedc09348fd7b9c7ce79e0cf4e83d699af76e7bde45f0eeb0" },
    { name: "migrations/0008_oauth_installation.sql", digest: "sha256:54c0309975576fa032d7bcded26bc4f49e9a66b100b5bc7dec2127c828f6b896" },
    { name: "migrations/0009_guest_permission_grants.sql", digest: "sha256:aabe862138e1121ee0b0147df7048c5b850e3c53f5d77cefd7ed9a0b33fb1bf6" },
    { name: "migrations/0010_oauth_refresh.sql", digest: "sha256:50340870c588f9fb6ba231eb1e8e30b95644f18cdabed8c4d68be09879ec0b0a" },
    { name: "migrations/0011_machine_kinds.sql", digest: "sha256:9c45071f74aa45646411c5415a8355fadb7b014e5adb9c35ef5d15012dcbecee" },
    { name: "migrations/0012_browser_purpose.sql", digest: "sha256:c7a57c01ed187961fadf68405650386769e5b590c8aa1ada5f75798583ec5c1a" }
  ]);
});

test("deleting a migration already present at the base fails the append-only guard", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-release-migration-test-"));
  const migrationPath = path.join(temporaryRoot, "services/msg/worker/migrations/0001_initial.sql");
  try {
    fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
    fs.writeFileSync(migrationPath, "CREATE TABLE messages (id TEXT PRIMARY KEY);\n", "utf8");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Release Test"],
      ["config", "user.email", "release-test@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "initial migration"]
    ]) {
      execFileSync("git", args, { cwd: temporaryRoot, stdio: "ignore" });
    }
    fs.rmSync(migrationPath);

    assert.throws(
      () => assertAppendOnlyD1Migrations({
        repositoryRoot: temporaryRoot,
        source: "services/msg/worker/migrations",
        baseCommit: "HEAD"
      }),
      /D1 migration history is not append-only: removed services\/msg\/worker\/migrations\/0001_initial\.sql/
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("neutral Wrangler config excludes environment-owned values", () => {
  const neutral = neutralWranglerConfig(config.units[0]);

  assert.deepEqual(neutral, {
    $schema: "https://developers.cloudflare.com/workers/wrangler/config-schema.json",
    main: "worker.js",
    compatibility_date: "2026-08-09",
    compatibility_flags: ["nodejs_compat"],
    rules: [
      { type: "Text", globs: ["**/*.svg"], fallthrough: true }
    ],
    workers_dev: false,
    durable_objects: {
      bindings: [{ name: "ConversationRoom", class_name: "ConversationRoom" }]
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ConversationRoom"] }],
    secrets: {
      required: [
        "MSG_DATA_ENCRYPTION_KEY_V1",
        "MSG_PLATFORM_SERVICE_VERIFIER",
        "MSG_PLATFORM_GUEST_GRANT_ISSUER",
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

test("packaged Wrangler config and manifest share the release public contract", () => {
  const msg = config.units[0];
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/worker/src/worker.ts"] });
  const neutral = neutralWranglerConfig(msg);
  const manifest = workerArtifactManifest(msg, plan);

  assert.equal(neutral.compatibility_date, manifest.compatibility_date);
  assert.deepEqual(neutral.compatibility_flags, manifest.compatibility_flags);
  assert.deepEqual(neutral.durable_objects, manifest.durable_objects);
  assert.deepEqual(neutral.migrations, manifest.migrations);
  assert.deepEqual(neutral.d1_databases, manifest.d1_databases);
  assert.deepEqual(neutral.secrets?.required, manifest.required_secrets);
  assert.deepEqual(neutral.observability, manifest.observability);
  assert.deepEqual(neutral.assets, manifest.assets);
  assert.deepEqual(neutral.triggers, manifest.triggers);
  assert.deepEqual(neutral.rules, manifest.rules);
});

test("generated Wrangler modules are copied with exact paths and digests", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-generated-modules-test-"));
  const outputDirectory = path.join(temporaryRoot, "wrangler-output");
  const artifactRoot = path.join(temporaryRoot, "artifact");
  try {
    fs.mkdirSync(path.join(outputDirectory, "nested"), { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(
      path.join(outputDirectory, "worker-entry.js"),
      'import rootIcon from "./root.svg"; import nestedIcon from "./nested/icon.svg"; export default { fetch() { return new Response(rootIcon + nestedIcon); } };\n',
      "utf8"
    );
    fs.writeFileSync(path.join(outputDirectory, "root.svg"), "<svg>root</svg>\n", "utf8");
    fs.writeFileSync(path.join(outputDirectory, "nested/icon.svg"), '<svg><text>from "./license"</text></svg>\n', "utf8");
    fs.writeFileSync(path.join(outputDirectory, "worker-entry.js.map"), "timestamped source map\n", "utf8");
    fs.writeFileSync(path.join(outputDirectory, "README.md"), "timestamped README\n", "utf8");

    const modules = copyGeneratedModules({
      outputDirectory,
      generatedEntrypoint: path.join(outputDirectory, "worker-entry.js"),
      artifactRoot,
      rules: [{ type: "Text", globs: ["**/*.svg"], fallthrough: true }]
    });
    assert.deepEqual(modules, [
      { name: "nested/icon.svg", type: "Text", digest: `sha256:${sha256(Buffer.from('<svg><text>from "./license"</text></svg>\n'))}` },
      { name: "root.svg", type: "Text", digest: `sha256:${sha256(Buffer.from("<svg>root</svg>\n"))}` }
    ]);
    assert.equal(fs.readFileSync(path.join(artifactRoot, "nested/icon.svg"), "utf8"), '<svg><text>from "./license"</text></svg>\n');
    assert.equal(fs.readFileSync(path.join(artifactRoot, "root.svg"), "utf8"), "<svg>root</svg>\n");

    fs.rmSync(path.join(outputDirectory, "root.svg"));
    assert.throws(
      () => copyGeneratedModules({
        outputDirectory,
        generatedEntrypoint: path.join(outputDirectory, "worker-entry.js"),
        artifactRoot: path.join(temporaryRoot, "missing-artifact"),
        rules: [{ type: "Text", globs: ["**/*.svg"], fallthrough: true }]
      }),
      /missing from Wrangler output: root\.svg/
    );
    fs.writeFileSync(path.join(outputDirectory, "root.svg"), "<svg>root</svg>\n", "utf8");

    fs.writeFileSync(path.join(outputDirectory, "unexpected.bin"), "runtime?\n", "utf8");
    assert.throws(
      () => copyGeneratedModules({
        outputDirectory,
        generatedEntrypoint: path.join(outputDirectory, "worker-entry.js"),
        artifactRoot: path.join(temporaryRoot, "second-artifact"),
        rules: [{ type: "Text", globs: ["**/*.svg"], fallthrough: true }]
      }),
      /unsupported file: unexpected\.bin/
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("Msg wrapper source config is normalized and checked against the release contract", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-release-config-test-"));
  const temporaryConfig = path.join(temporaryRoot, "services/msg/wrangler.jsonc");
  const msg = config.units[0];
  const build = { ...msg.build, config_path: "services/msg/wrangler.jsonc" };
  const unit = { ...msg, build };
  const source = readJsonc(path.join(repositoryRoot, "services/msg/wrangler.jsonc"));
  const writeSource = () => {
    fs.mkdirSync(path.dirname(temporaryConfig), { recursive: true });
    fs.writeFileSync(temporaryConfig, JSON.stringify(source, null, 2), "utf8");
  };

  try {
    writeSource();
    assert.doesNotThrow(() => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot));

    source.rules[0].globs = ["**/*.png"];
    writeSource();
    assert.throws(
      () => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot),
      /rules does not match/
    );
    source.rules[0].globs = ["**/*.svg"];

    source.d1_databases[0].database_id = "11111111-2222-4333-8444-555555555555";
    source.ratelimits[0].namespace_id = "9999999999";
    writeSource();
    assert.doesNotThrow(() => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot));

    source.assets.html_handling = "auto-trailing-slash";
    writeSource();
    assert.throws(
      () => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot),
      /assets contains unsupported keys/
    );
    delete source.assets.html_handling;

    source.compatibility_date = "2026-08-10";
    writeSource();
    assert.throws(
      () => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot),
      /compatibility_date does not match/
    );

    source.compatibility_date = "2026-08-09";
    source.observability.enabled = false;
    writeSource();
    assert.throws(
      () => assertWorkerBuildConfigMatchesSource(unit, build, temporaryRoot),
      /observability does not match/
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("Worker changes select their configured release units", () => {
  assert.deepEqual(
    affectedUnits(config, ["services/msg/worker/src/worker.ts", "services/msg/worker/test/health.test.ts"])
      .map((unit) => unit.name),
    ["msg-worker"]
  );
  assert.deepEqual(affectedUnits(config, ["services/msg/cli/src/cli.ts"]), []);
  assert.deepEqual(affectedUnits(config, ["services/gateway/src/worker.ts"]).map((unit) => unit.name), ["gateway"]);
  assert.deepEqual(affectedUnits(config, ["services/database/src/worker.ts"]).map((unit) => unit.name), ["database-worker"]);
  assert.deepEqual(affectedUnits(config, ["bun.lock"]).map((unit) => unit.name), ["database-worker", "gateway", "msg-webhook-dispatcher", "msg-worker", "platform-worker"]);
  assert.deepEqual(affectedUnits(config, [".github/workflows/release.yml"]).map((unit) => unit.name), ["msg-worker"]);
});

test("the first Database activation publishes only its new artifact", () => {
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name !== "database-worker") };
  const plan = makePlan({
    config,
    previousConfig,
    base: head,
    head,
    changedFiles: ["release-units.json"]
  });

  assert.equal(plan.change_class, "runtime");
  assert.equal(plan.runtime_redeployment, true);
  assert.deepEqual(plan.affected_units, ["database-worker"]);
  assert.deepEqual(plan.artifacts.map((artifact) => artifact.name), ["database-worker"]);
});

test("unit registration retains simultaneous runtime and global inputs", () => {
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name !== "database-worker") };
  assert.deepEqual(
    affectedUnits(config, ["release-units.json", "services/msg/worker/src/worker.ts"], previousConfig)
      .map((unit) => unit.name),
    ["database-worker", "msg-worker"]
  );
  assert.deepEqual(
    affectedUnits(config, ["release-units.json", "bun.lock"], previousConfig).map((unit) => unit.name),
    ["database-worker", "gateway", "msg-webhook-dispatcher", "msg-worker", "platform-worker"]
  );
});

test("changes to existing unit definitions remain conservative", () => {
  const previousConfig = {
    ...config,
    units: config.units.map((unit) => unit.name === "msg-worker"
      ? { ...unit, build: { ...unit.build, compatibility_date: "2026-08-08" } }
      : unit)
  };
  assert.deepEqual(
    affectedUnits(config, ["release-units.json"], previousConfig).map((unit) => unit.name),
    ["database-worker", "gateway", "msg-webhook-dispatcher", "msg-worker", "platform-worker"]
  );
});

test("a release contract change alongside a new unit remains conservative", () => {
  const previousConfig = {
    ...config,
    release: { ...config.release, compatibility: { api: "v0", config: "v1" } },
    units: config.units.filter((unit) => unit.name !== "database-worker")
  };
  assert.deepEqual(
    affectedUnits(config, ["release-units.json"], previousConfig).map((unit) => unit.name),
    ["database-worker", "gateway", "msg-webhook-dispatcher", "msg-worker", "platform-worker"]
  );
});

test("deletion-only Msg source changes still trigger a runtime artifact", () => {
  const plan = makePlan({
    config,
    base: head,
    head,
    changedFiles: ["services/msg/worker/src/removed-route.ts"]
  });

  assert.equal(plan.change_class, "runtime");
  assert.equal(plan.runtime_redeployment, true);
  assert.deepEqual(plan.affected_units, ["msg-worker"]);
  assert.deepEqual(plan.artifacts.map((artifact) => artifact.name), ["msg-worker"]);
});

test("Git changed path discovery includes deletions", () => {
  let received;
  const files = changedFiles("base", "head", (...args) => {
    received = args;
    return "services/msg/worker/src/removed-route.ts\n";
  });

  assert.deepEqual(files, ["services/msg/worker/src/removed-route.ts"]);
  assert.deepEqual(received, ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "base", "head"]);
});

test("release planner reads the unit map from the push base commit", () => {
  let received;
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name !== "database-worker") };
  const result = readBaseReleaseConfig(head, (...args) => {
    received = args;
    return JSON.stringify(previousConfig);
  });

  assert.deepEqual(result, previousConfig);
  assert.deepEqual(received, ["show", `${head}:release-units.json`]);
  assert.equal(readBaseReleaseConfig("0".repeat(40), () => assert.fail("zero base should not be read")), undefined);
  assert.equal(readBaseReleaseConfig("main", () => "{}"), undefined);
  assert.equal(readBaseReleaseConfig(head, () => "not json"), undefined);
  assert.equal(readBaseReleaseConfig(head, () => { throw new Error("missing base config"); }), undefined);
  assert.deepEqual(
    affectedUnits(config, ["release-units.json"], readBaseReleaseConfig(head, () => "not json"))
      .map((unit) => unit.name),
    ["database-worker", "gateway", "msg-webhook-dispatcher", "msg-worker", "platform-worker"]
  );
});

test("moving a Msg asset into docs still releases Msg for the source deletion", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-release-rename-test-"));
  const sourcePath = path.join(temporaryRoot, "services/msg/worker/public/removed-asset.js");
  const destinationPath = path.join(temporaryRoot, "docs/removed-asset.md");
  const runGit = (args) => {
    const result = spawnSync("git", args, { cwd: temporaryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
    return result.stdout;
  };
  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export const removed = true;\n", "utf8");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Release Test"],
      ["config", "user.email", "release-test@example.invalid"],
      ["add", "."],
      ["commit", "-qm", "initial Msg asset"]
    ]) runGit(args);
    const base = runGit(["rev-parse", "HEAD"]).trim();

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.renameSync(sourcePath, destinationPath);
    for (const args of [["add", "-A"], ["commit", "-qm", "move Msg asset to docs"]]) runGit(args);
    const next = runGit(["rev-parse", "HEAD"]).trim();
    const changed = changedFiles(base, next, (...args) => runGit(args));

    assert.deepEqual(changed.sort(), ["docs/removed-asset.md", "services/msg/worker/public/removed-asset.js"]);
    const plan = makePlan({ config, base, head: next, changedFiles: changed });
    assert.deepEqual(plan.affected_units, ["msg-worker"]);
    assert.equal(plan.runtime_redeployment, true);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
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
    "services/database/scripts/check",
    "services/database/test/durable.spec.ts",
    "services/platform/docs/README.md"
  ]) {
    const plan = makePlan({ config, base: head, head, changedFiles: [changedFile] });
    assert.equal(plan.change_class, changedFile.endsWith("README.md") ? "documentation" : "non-runtime");
    assert.equal(plan.runtime_redeployment, false);
    assert.deepEqual(plan.affected_units, []);
    assert.deepEqual(plan.artifacts, []);
  }
});

test("Platform runtime changes select the released unit and mix with other units", () => {
  for (const changedFile of [
    "services/platform/src/worker.ts",
    "services/platform/migrations/0001_better_auth.sql",
    "services/platform/wrangler.jsonc",
    "services/platform/scripts/wrangler-config.ts",
  ]) {
    const plan = makePlan({ config, base: head, head, changedFiles: [changedFile] });
    assert.equal(plan.change_class, "runtime");
    assert.equal(plan.runtime_redeployment, true);
    assert.deepEqual(plan.affected_units, ["platform-worker"]);
    assert.deepEqual(plan.artifacts.map((artifact) => artifact.name), ["platform-worker"]);
  }

  const validationOnlyPlan = makePlan({
    config,
    base: head,
    head,
    changedFiles: ["services/platform/.dev.vars.example"]
  });
  assert.equal(validationOnlyPlan.change_class, "non-runtime");
  assert.equal(validationOnlyPlan.runtime_redeployment, false);
  assert.deepEqual(validationOnlyPlan.affected_units, []);
  assert.deepEqual(validationOnlyPlan.artifacts, []);

  const mixedPlan = makePlan({
    config,
    base: head,
    head,
    changedFiles: ["services/platform/src/worker.ts", "services/msg/worker/src/worker.ts"]
  });
  assert.equal(mixedPlan.change_class, "runtime");
  assert.equal(mixedPlan.runtime_redeployment, true);
  assert.deepEqual(mixedPlan.affected_units, ["msg-worker", "platform-worker"]);
  assert.deepEqual(mixedPlan.artifacts.map((artifact) => artifact.name), ["msg-worker", "platform-worker"]);
});

test("unmapped service and app runtime changes fail closed", () => {
  for (const service of ["brain"]) {
    for (const runtimePath of ["src/index.ts", "config/runtime.json", "migrations/0001_init.sql"]) {
      assert.throws(
        () => makePlan({ config, base: head, head, changedFiles: [`services/${service}/${runtimePath}`] }),
        /unmapped runtime changes require an explicit release unit before merge/
      );
    }
  }
  for (const runtimePath of ["config/runtime.json", "migrations/0001_init.sql"]) {
    assert.throws(
      () => makePlan({ config, base: head, head, changedFiles: [`services/database/${runtimePath}`] }),
      /unmapped runtime changes require an explicit release unit before merge/
    );
  }
  assert.deepEqual(
    makePlan({ config, base: head, head, changedFiles: ["services/database/src/index.ts"] }).affected_units,
    ["database-worker"]
  );
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
  const cloudDispatchGate = "steps.plan.outputs.runtime_redeployment == 'true' && vars.CLOUD_RELEASE_DISPATCH_ENABLED == 'true'";
  assert.equal(releaseWorkflow.split(cloudDispatchGate).length - 1, 3);
  assert.match(releaseWorkflow, /CLOUD_RELEASE_DISPATCH_ENABLED/);
  const publishStart = releaseWorkflow.indexOf("      - name: Create, populate, and publish immutable GitHub release");
  const notifyStart = releaseWorkflow.indexOf("      - name: Notify private Cloud staging", publishStart);
  assert.ok(publishStart >= 0 && notifyStart > publishStart);
  const publishBlock = releaseWorkflow.slice(publishStart, notifyStart);
  assert.doesNotMatch(publishBlock, /^        if:/m);
  assert.match(publishBlock, /gh release upload/);
  assert.match(publishBlock, /releases\?per_page=100/);
  assert.ok(publishBlock.includes('select(.tag_name == \\"$RELEASE_TAG\\")'));
  assert.match(publishBlock, /multiple GitHub releases use tag/);
  assert.match(publishBlock, /releases\/\$release_id/);
  assert.doesNotMatch(publishBlock, /releases\/tags\/\$RELEASE_TAG/);
  assert.match(publishBlock, /gh release view "\$RELEASE_TAG" --repo "\$GITHUB_REPOSITORY" --json assets/);
});

test("draft release publication retries delayed list visibility and validates numeric metadata", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "0000-release-publish-test-"));
  const binDirectory = path.join(temporaryRoot, "bin");
  const artifactDirectory = path.join(temporaryRoot, "artifacts");
  const statePath = path.join(temporaryRoot, "gh-state");
  const logPath = path.join(temporaryRoot, "gh.log");
  const publishScriptPath = path.join(temporaryRoot, "publish.sh");
  const mockGhPath = path.join(binDirectory, "gh");
  const mockSleepPath = path.join(binDirectory, "sleep");
  const publishStart = releaseWorkflow.indexOf("      - name: Create, populate, and publish immutable GitHub release");
  const scriptStart = releaseWorkflow.indexOf("          set -euo pipefail", publishStart);
  const scriptEnd = releaseWorkflow.indexOf("\n      - name: Notify private Cloud staging", scriptStart);
  const publishScript = releaseWorkflow
    .slice(scriptStart, scriptEnd)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  const mockGh = `#!/usr/bin/env bash
set -euo pipefail
state="$MOCK_GH_STATE"
log="$MOCK_GH_LOG"
printf '%s\\n' "$*" >> "$log"

if [ "$1" = "api" ]; then
  request="$*"
  if [[ "$request" == *"immutable-releases"* ]]; then
    printf 'true\\n'
    exit 0
  fi
  if [[ "$request" == *"git/ref/tags/"* ]]; then
    if [ -f "$state.published" ]; then
      printf 'commit\\t%s\\n' "$GITHUB_SHA"
      exit 0
    fi
    exit 1
  fi
  if [[ "$request" == *"releases?per_page=100"* ]]; then
    count=0
    if [ -f "$state.list_count" ]; then count=$(cat "$state.list_count"); fi
    count=$((count + 1))
    printf '%s\\n' "$count" > "$state.list_count"
    if [ "$count" -ge 3 ]; then printf '399750313\\n'; fi
    exit 0
  fi
  if [[ "$request" == *"releases/399750313"* ]]; then
    if [[ "$request" == *".draft"* ]]; then
      if [ -f "$state.published" ]; then printf 'false\\n'; else printf 'true\\n'; fi
      exit 0
    fi
    if [[ "$request" == *".target_commitish"* ]]; then
      printf '%s\\n' "$GITHUB_SHA"
      exit 0
    fi
    if [[ "$request" == *".immutable"* ]]; then
      printf 'true\\n'
      exit 0
    fi
  fi
  printf 'unexpected gh api request: %s\\n' "$request" >&2
  exit 2
fi

if [ "$1" = "release" ]; then
  case "$2" in
    create) touch "$state.created" ;;
    view) exit 0 ;;
    upload) printf '%s\\n' "$*" >> "$state.uploads" ;;
    edit) touch "$state.published" ;;
    *) printf 'unexpected gh release request: %s\\n' "$*" >&2; exit 2 ;;
  esac
  exit 0
fi

printf 'unexpected gh request: %s\\n' "$*" >&2
exit 2
`;
  const mockSleep = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_GH_SLEEP_LOG"
`;

  try {
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.writeFileSync(mockGhPath, mockGh, "utf8");
    fs.writeFileSync(mockSleepPath, mockSleep, "utf8");
    fs.chmodSync(mockGhPath, 0o755);
    fs.chmodSync(mockSleepPath, 0o755);
    fs.writeFileSync(publishScriptPath, publishScript, "utf8");
    fs.chmodSync(publishScriptPath, 0o755);
    fs.writeFileSync(path.join(temporaryRoot, "0000-release-record.json"), "record\\n", "utf8");
    fs.writeFileSync(path.join(temporaryRoot, "0000-release-event.json"), "event\\n", "utf8");
    fs.writeFileSync(path.join(artifactDirectory, "msg-worker.artifact.json"), "metadata\\n", "utf8");
    fs.writeFileSync(path.join(artifactDirectory, "msg-worker.tar.gz"), "bundle\\n", "utf8");

    const releaseTag = `v0.0.0-${head}`;
    const result = spawnSync("bash", [publishScriptPath], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        ARTIFACT_DIR: artifactDirectory,
        GITHUB_REPOSITORY: "0000-chat/0000",
        GITHUB_SHA: head,
        MOCK_GH_LOG: logPath,
        MOCK_GH_SLEEP_LOG: path.join(temporaryRoot, "sleep.log"),
        MOCK_GH_STATE: statePath,
        RELEASE_EVENT: path.join(temporaryRoot, "0000-release-event.json"),
        RELEASE_RECORD: path.join(temporaryRoot, "0000-release-record.json"),
        RELEASE_TAG: releaseTag,
        RUNNER_TEMP: temporaryRoot
      }
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.readFileSync(`${statePath}.list_count`, "utf8").trim(), "3");
    assert.equal(fs.readFileSync(`${statePath}.uploads`, "utf8").trim().split("\n").length, 4);
    assert.equal(fs.existsSync(`${statePath}.published`), true);
    assert.match(result.stdout, /validating the draft target/);
    const log = fs.readFileSync(logPath, "utf8");
    assert.ok(log.includes("releases?per_page=100"));
    assert.ok(log.includes("releases/399750313"));
    assert.match(log, /target_commitish/);
    assert.match(log, /\.immutable/);
    assert.match(log, /release view .* --json assets/);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
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
    modules: [
      { name: "hashed-icon.svg", type: "Text", digest: `sha256:${"m".repeat(64)}` }
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
  assert.deepEqual(record.artifacts[0].modules, [
    { name: "hashed-icon.svg", type: "Text", digest: `sha256:${"m".repeat(64)}` }
  ]);
  assert.equal(record.publication_policy.production_deployment, false);
});

test("Database release records carry only finite public capacity policy", () => {
  const database = config.units.find((unit) => unit.name === "database-worker");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/database/src/worker.ts"] });
  const vars = database.build.wrangler.vars;
  const record = createReleaseRecord(plan, [{
    name: database.name,
    version: plan.release_version,
    kind: database.kind,
    media_type: "application/gzip",
    asset_name: `database-worker-${plan.release_version}.tar.gz`,
    digest: `sha256:${"d".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: database.archive_paths,
    artifact_format: "0000-cloudflare-worker-bundle-v1",
    entrypoint: "worker.js",
    config: "wrangler.json",
    files: ["worker.js", "wrangler.json", "artifact-manifest.json"],
    vars
  }]);

  assert.deepEqual(record.artifacts[0].vars, vars);
  assert.equal(Object.keys(vars).some((name) => /account|domain|secret|token|route/i.test(name)), false);
  assert.equal(Object.values(vars).every((value) => typeof value === "string"), true);
  for (const [name, value] of Object.entries(vars)) {
    if (name !== "SERVICE_SUSPENDED") assert.match(value, /^[1-9][0-9]*$/);
  }
  assert.equal(vars.SERVICE_SUSPENDED, "false");
});

test("Bun dispatcher release records carry a self-hosted runtime contract", () => {
  const dispatcher = config.units.find((unit) => unit.name === "msg-webhook-dispatcher");
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/msg/scripts/mcp-webhook-dispatcher.ts"] });
  const record = createReleaseRecord(plan, [{
    name: dispatcher.name,
    version: plan.release_version,
    kind: dispatcher.kind,
    media_type: "application/gzip",
    asset_name: `msg-webhook-dispatcher-${plan.release_version}.tar.gz`,
    digest: `sha256:${"f".repeat(64)}`,
    compatibility: config.release.compatibility,
    source_commit: head,
    archive_paths: dispatcher.archive_paths,
    artifact_format: "0000-bun-runtime-bundle-v1",
    entrypoint: dispatcher.build.entrypoint,
    files: dispatcher.build.files,
    entrypoint_digest: `sha256:${"e".repeat(64)}`,
    runtime: dispatcher.build.runtime,
  }]);

  assert.equal(record.artifacts[0].artifact_format, "0000-bun-runtime-bundle-v1");
  assert.deepEqual(record.artifacts[0].runtime, dispatcher.build.runtime);
  assert.deepEqual(record.cloud_selection.artifacts, []);
  assert.equal(JSON.stringify(record).includes("MSG_MCP_WEBHOOK_DISPATCH_TOKEN"), true);
  assert.equal(JSON.stringify(record).includes("Bearer"), false);
  assert.equal(JSON.stringify(record).includes("https://"), false);
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
