#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, stableJson } from "./lib.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function createReleaseRecord(plan, metadata) {
  const artifacts = [...metadata]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((artifact) => {
      const record = {
        name: artifact.name,
        version: artifact.version,
        digest: artifact.digest,
        asset_name: artifact.asset_name,
        kind: artifact.kind,
        media_type: artifact.media_type,
        compatibility: artifact.compatibility,
        source_commit: artifact.source_commit,
        archive_paths: artifact.archive_paths
      };
      for (const key of [
        "artifact_format",
        "entrypoint",
        "config",
        "files",
        "directories",
        "migration_files",
        "entrypoint_digest",
        "deployment"
      ]) {
        if (artifact[key] !== undefined) record[key] = artifact[key];
      }
      return record;
    });
  return {
    $schema: plan.$schema,
    schema_version: 1,
    product: "0000",
    release: {
      version: plan.release_version,
      source: {
        repository: "0000-chat/0000",
        ref: "refs/heads/main",
        commit: plan.source_commit
      },
      compatibility: plan.compatibility,
      change_class: plan.change_class,
      runtime_redeployment: plan.runtime_redeployment
    },
    artifacts,
    cloud_selection: {
      release: {
        version: plan.release_version,
        compatibility: plan.compatibility
      },
      artifacts: artifacts.map(({ name, version, digest, compatibility, kind, media_type, asset_name }) => ({
        name,
        version,
        digest,
        compatibility,
        kind,
        media_type,
        asset_name
      }))
    },
    publication_policy: {
      production_deployment: false,
      sdk_publication: false,
      cli_publication: false,
      cloud_promotion: "private-only"
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const planPath = argument("--plan");
  const artifactDirectory = argument("--artifact-dir");
  const outputPath = argument("--output");
  if (!planPath || !artifactDirectory || !outputPath) {
    throw new Error("usage: record.mjs --plan PLAN --artifact-dir DIRECTORY --output FILE");
  }

  const plan = readJson(planPath);
  const metadata = (fs.existsSync(artifactDirectory) ? fs.readdirSync(artifactDirectory) : [])
    .filter((name) => name.endsWith(".artifact.json"))
    .sort()
    .map((name) => readJson(path.join(artifactDirectory, name)));
  const expected = [...plan.affected_units].sort();
  const actual = metadata.map((entry) => entry.name).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`artifact set does not match release plan: expected ${expected.join(",")}, got ${actual.join(",")}`);
  }

  const record = createReleaseRecord(plan, metadata);
  fs.writeFileSync(outputPath, stableJson(record), "utf8");
  process.stdout.write(stableJson(record));
}
