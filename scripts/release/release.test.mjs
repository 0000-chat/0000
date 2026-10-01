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

test("release configuration activates the Msg and Gateway Workers", () => {
  assert.doesNotThrow(() => assertReleaseConfig(config));
  assert.deepEqual(config.units.map((unit) => unit.name), ["msg-worker", "gateway"]);

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
  assert.deepEqual(affectedUnits(config, ["bun.lock"]).map((unit) => unit.name), ["gateway", "msg-worker"]);
  assert.deepEqual(affectedUnits(config, [".github/workflows/release.yml"]).map((unit) => unit.name), ["msg-worker"]);
});

test("an additive release-unit registration publishes only its first artifact", () => {
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name === "msg-worker") };
  const plan = makePlan({
    config,
    previousConfig,
    base: head,
    head,
    changedFiles: ["release-units.json"]
  });

  assert.equal(plan.change_class, "runtime");
  assert.equal(plan.runtime_redeployment, true);
  assert.deepEqual(plan.affected_units, ["gateway"]);
  assert.deepEqual(plan.artifacts.map((artifact) => artifact.name), ["gateway"]);
});

test("unit registration retains simultaneous runtime and global inputs", () => {
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name === "msg-worker") };
  assert.deepEqual(
    affectedUnits(config, ["release-units.json", "services/msg/worker/src/worker.ts"], previousConfig)
      .map((unit) => unit.name),
    ["gateway", "msg-worker"]
  );
  assert.deepEqual(
    affectedUnits(config, ["release-units.json", "bun.lock"], previousConfig).map((unit) => unit.name),
    ["gateway", "msg-worker"]
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
    ["gateway", "msg-worker"]
  );
});

test("a release contract change alongside a new unit remains conservative", () => {
  const previousConfig = {
    ...config,
    release: { ...config.release, compatibility: { api: "v0", config: "v1" } },
    units: config.units.filter((unit) => unit.name === "msg-worker")
  };
  assert.deepEqual(
    affectedUnits(config, ["release-units.json"], previousConfig).map((unit) => unit.name),
    ["gateway", "msg-worker"]
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
  const previousConfig = { ...config, units: config.units.filter((unit) => unit.name === "msg-worker") };
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
    ["gateway", "msg-worker"]
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
