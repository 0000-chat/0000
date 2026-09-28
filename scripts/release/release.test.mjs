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
import { workerArtifactManifest } from "./worker.mjs";

const config = readReleaseConfig();
const head = "0123456789abcdef0123456789abcdef01234567";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseWorkflowPath = path.join(repositoryRoot, ".github/workflows/release.yml");
const legacyGatewayWorkflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-gateway.yml"), "utf8");

test("release unit configuration is valid and excludes private or non-runtime publications", () => {
  assert.doesNotThrow(() => assertReleaseConfig(config));
  const names = config.units.map((unit) => unit.name);
  assert.deepEqual(names, ["gateway"]);
  assert.equal(names.some((name) => /sdk|cli|cloud/i.test(name)), false);
  assert.equal(config.units.some((unit) => unit.name !== "gateway"), false);
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

test("documentation-only changes create no runtime redeployment", () => {
  const changed = ["README.md", "docs/release-artifacts.md", "services/gateway/docs/README.md"];
  assert.deepEqual(affectedUnits(config, changed), []);
  assert.equal(classifyChanges(changed, []), "documentation");
  const plan = makePlan({ config, base: head, head, changedFiles: changed });
  assert.equal(plan.runtime_redeployment, false);
  assert.deepEqual(plan.affected_units, []);
  assert.deepEqual(plan.artifacts, []);
});

test("non-Gateway service changes publish no runtime artifact", () => {
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

test("release scaffolding is dormant until a separate activation workflow is reviewed", () => {
  assert.equal(fs.existsSync(releaseWorkflowPath), false);
});

test("activation-workflow and documentation changes produce zero runtime artifacts", () => {
  for (const changed of [[".github/workflows/release.yml"], ["docs/release-activation.md"]]) {
    const plan = makePlan({ config, base: head, head, changedFiles: changed });
    assert.equal(plan.runtime_redeployment, false);
    assert.deepEqual(plan.affected_units, []);
    assert.deepEqual(plan.artifacts, []);
  }
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
    kind: "cloudflare-worker-bundle",
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
    kind: "cloudflare-worker-bundle",
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
    kind: "cloudflare-worker-bundle",
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
        kind: "cloudflare-worker-bundle",
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
    kind: "cloudflare-worker-bundle",
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
