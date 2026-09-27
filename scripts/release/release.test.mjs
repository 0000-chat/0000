import assert from "node:assert/strict";
import test from "node:test";
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

const config = readReleaseConfig();
const head = "0123456789abcdef0123456789abcdef01234567";

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
    compatibility: config.release.compatibility
  }]);
  assert.equal(record.publication_policy.production_deployment, false);
});

test("Cloud dispatch event uses the nested immutable release contract", () => {
  const plan = makePlan({ config, base: head, head, changedFiles: ["services/gateway/src/worker.ts"] });
  const record = createReleaseRecord(plan, [{
    name: "gateway",
    version: plan.release_version,
    kind: "cloudflare-worker-source",
    media_type: "application/gzip",
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
        compatibility: config.release.compatibility
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
