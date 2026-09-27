#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
  assertReleaseConfig,
  readJson,
  readReleaseConfig,
  repositoryRoot,
  sha256,
  stableJson
} from "./lib.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function archiveUnit(unit, commit) {
  const result = spawnSync(
    "git",
    ["archive", "--format=tar", `--prefix=${unit.name}/`, commit, "--", ...unit.archive_paths],
    // spawnSync defaults to a 1 MiB output buffer. The communicator and msg
    // source bundles are intentionally larger than that, so keep the
    // bounded in-memory implementation explicit instead of silently failing
    // with ENOBUFS on a larger affected unit.
    { cwd: repositoryRoot, encoding: null, maxBuffer: 128 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim();
    const reason = result.error?.message || `status=${result.status ?? "null"} signal=${result.signal ?? "none"}`;
    throw new Error(detail || `git archive failed: ${reason}`);
  }
  if (!result.stdout || result.stdout.length === 0) throw new Error(`empty archive for ${unit.name}`);
  return gzipSync(result.stdout, { level: 9, mtime: 0 });
}

const planPath = argument("--plan");
const outputDirectory = argument("--output-dir");
if (!planPath || !outputDirectory) throw new Error("usage: build.mjs --plan PLAN --output-dir DIRECTORY");

const plan = readJson(planPath);
const config = assertReleaseConfig(readReleaseConfig());
const units = new Map(config.units.map((unit) => [unit.name, unit]));
fs.mkdirSync(outputDirectory, { recursive: true });

for (const name of plan.affected_units) {
  const unit = units.get(name);
  if (!unit) throw new Error(`plan references unknown release unit: ${name}`);
  const bytes = archiveUnit(unit, plan.source_commit);
  const digest = `sha256:${sha256(bytes)}`;
  const archiveName = `${unit.name}-${plan.release_version}.tar.gz`;
  fs.writeFileSync(path.join(outputDirectory, archiveName), bytes);
  const metadata = {
    schema_version: 1,
    product: "0000",
    name: unit.name,
    version: plan.release_version,
    kind: unit.kind,
    digest,
    media_type: "application/gzip",
    compatibility: plan.compatibility,
    source_commit: plan.source_commit,
    archive_paths: unit.archive_paths
  };
  fs.writeFileSync(path.join(outputDirectory, `${unit.name}.artifact.json`), stableJson(metadata), "utf8");
  process.stdout.write(`${unit.name}: ${digest}\n`);
}
