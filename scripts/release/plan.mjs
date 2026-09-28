#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
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

function changedFiles(base, head) {
  if (base && !/^0+$/.test(base)) {
    return git("diff", "--name-only", "--diff-filter=ACMRTUXB", base, head).split("\n").filter(Boolean);
  }
  return git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACMRTUXB", head)
    .split("\n")
    .filter(Boolean);
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

const head = argument("--head", git("rev-parse", "HEAD"));
const base = argument("--base");
const filesArgument = argument("--files");
const changed = filesArgument
  ? JSON.parse(fs.readFileSync(filesArgument, "utf8"))
  : changedFiles(base, head);
if (!Array.isArray(changed)) throw new Error("--files must contain a JSON array");

const plan = makePlan({ config: readReleaseConfig(), base, head, changedFiles: changed });
const output = argument("--output");
if (output) fs.writeFileSync(output, stableJson(plan), "utf8");
writeGithubOutput(argument("--github-output"), plan);
process.stdout.write(stableJson(plan));
