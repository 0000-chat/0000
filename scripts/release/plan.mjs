#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertReleaseConfig,
  makePlan,
  readReleaseConfig,
  repositoryRoot,
  stableJson
} from "./lib.mjs";

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git failed").trim());
  return result.stdout.trim();
}

export function changedFiles(base, head, gitRunner = git) {
  if (base && !/^0+$/.test(base)) {
    return gitRunner("diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", base, head).split("\n").filter(Boolean);
  }
  return gitRunner("diff-tree", "--no-renames", "--root", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACDMRTUXB", head)
    .split("\n")
    .filter(Boolean);
}

export function readBaseReleaseConfig(base, gitRunner = git) {
  if (!base || /^0+$/.test(base)) return undefined;
  if (!/^[0-9a-f]{40}$/.test(base)) return undefined;
  try {
    return assertReleaseConfig(JSON.parse(gitRunner("show", `${base}:release-units.json`)));
  } catch {
    return undefined;
  }
}

function writeGithubOutput(file, plan) {
  if (!file) return;
  fs.appendFileSync(
    file,
    [
      `release_version=${plan.release_version}`,
      `affected_units=${JSON.stringify(plan.affected_units)}`,
      `runtime_redeployment=${plan.runtime_redeployment}`,
      `change_class=${plan.change_class}`
    ].join("\n") + "\n",
    "utf8"
  );
}

function main() {
  const head = argument("--head", git("rev-parse", "HEAD"));
  const base = argument("--base");
  const filesArgument = argument("--files");
  const changed = filesArgument
    ? JSON.parse(fs.readFileSync(filesArgument, "utf8"))
    : changedFiles(base, head);
  if (!Array.isArray(changed)) throw new Error("--files must contain a JSON array");

  const previousConfig = changed.includes("release-units.json") ? readBaseReleaseConfig(base) : undefined;
  const plan = makePlan({ config: readReleaseConfig(), previousConfig, base, head, changedFiles: changed });
  const output = argument("--output");
  if (output) fs.writeFileSync(output, stableJson(plan), "utf8");
  writeGithubOutput(argument("--github-output"), plan);
  process.stdout.write(stableJson(plan));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
