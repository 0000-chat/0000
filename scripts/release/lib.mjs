import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const releaseUnitsPath = path.join(repositoryRoot, "release-units.json");
export const publicReleaseRecordSchema = "docs/schemas/public-release-record.schema.json";

const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readReleaseConfig(root = repositoryRoot) {
  return readJson(path.join(root, "release-units.json"));
}

export function normalisePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`release path must be a non-empty POSIX path: ${value}`);
  }
  const normalised = path.posix.normalize(value);
  if (normalised.startsWith("/") || normalised === ".." || normalised.startsWith("../")) {
    throw new Error(`release path escapes the repository: ${value}`);
  }
  return normalised;
}

export function assertReleaseConfig(config) {
  if (!config || config.schema_version !== 1 || config.product !== "0000") {
    throw new Error("release-units.json must describe schema version 1 for product 0000");
  }
  const compatibility = config.release?.compatibility;
  if (!compatibility || !NAME_RE.test(compatibility.api) || !NAME_RE.test(compatibility.config)) {
    throw new Error("release compatibility must define safe api and config identifiers");
  }
  if (config.release?.version_prefix !== "v0.0.0-") {
    throw new Error("release version prefix must be v0.0.0-");
  }
  if (!Array.isArray(config.units) || config.units.length === 0) {
    throw new Error("release-units.json must define at least one deployable unit");
  }

  const names = new Set();
  for (const unit of config.units) {
    if (!unit || !NAME_RE.test(unit.name) || names.has(unit.name)) {
      throw new Error(`release unit has a missing or duplicate name: ${unit?.name}`);
    }
    names.add(unit.name);
    if (!NAME_RE.test(unit.kind)) throw new Error(`invalid release unit kind: ${unit.name}`);
    if (!Array.isArray(unit.runtime_paths) || unit.runtime_paths.length === 0) {
      throw new Error(`release unit has no runtime paths: ${unit.name}`);
    }
    if (!Array.isArray(unit.archive_paths) || unit.archive_paths.length === 0) {
      throw new Error(`release unit has no archive paths: ${unit.name}`);
    }
    for (const value of [...unit.runtime_paths, ...unit.archive_paths]) {
      const normalised = normalisePath(value.replace(/\*+$/, ""));
      if (!normalised.startsWith("services/")) {
        throw new Error(`release unit path must be under services/: ${unit.name}: ${value}`);
      }
      if (normalised.includes("services/cloud") || normalised.includes("/cloud/")) {
        throw new Error(`private Cloud content cannot be a public release unit: ${unit.name}`);
      }
      if (normalised.includes("/cli") || normalised.includes("/sdk")) {
        throw new Error(`SDK and CLI content cannot be a public release unit: ${unit.name}`);
      }
    }
  }
  return config;
}

export function globToRegExp(pattern) {
  const value = normalisePath(pattern);
  let expression = "^";
  for (let index = 0; index < value.length; ) {
    if (value.startsWith("**/", index)) {
      expression += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (value.startsWith("**", index)) {
      expression += ".*";
      index += 2;
      continue;
    }
    const character = value[index];
    if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`${expression}$`);
}

export function matchesAny(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

export function unitAffectsFile(unit, file) {
  return matchesAny(file, unit.runtime_paths);
}

const GLOBAL_RUNTIME_INPUTS = new Set(["package.json", "bun.lock", "turbo.json", "release-units.json"]);

export function affectedUnits(config, changedFiles) {
  const files = [...new Set(changedFiles.map(normalisePath))].sort();
  if (files.some((file) => GLOBAL_RUNTIME_INPUTS.has(file))) return [...config.units].sort(byName);
  return config.units.filter((unit) => files.some((file) => unitAffectsFile(unit, file))).sort(byName);
}

export function isDocumentationPath(file) {
  return (
    file === "README.md" ||
    file.startsWith("docs/") ||
    file.includes("/docs/") ||
    /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|CODE_OF_CONDUCT)(?:\.[^.]+)?$/i.test(file) ||
    /\.(?:md|mdx|txt)$/i.test(file)
  );
}

export function classifyChanges(changedFiles, units) {
  const files = [...new Set(changedFiles)].sort();
  if (units.length > 0) return "runtime";
  if (files.length === 0) return "empty";
  if (files.every(isDocumentationPath)) return "documentation";
  return "non-runtime";
}

export function releaseVersion(commit) {
  if (!SHA_RE.test(commit)) throw new Error(`release source commit must be a full SHA: ${commit}`);
  return `v0.0.0-${commit}`;
}

export function makePlan({ config, base, head, changedFiles }) {
  assertReleaseConfig(config);
  const files = [...new Set(changedFiles.map(normalisePath))].sort();
  const units = affectedUnits(config, files);
  const changeClass = classifyChanges(files, units);
  return {
    $schema: publicReleaseRecordSchema,
    schema_version: 1,
    product: "0000",
    release_version: releaseVersion(head),
    source_commit: head,
    base_commit: base && !/^0+$/.test(base) ? base : null,
    changed_files: files,
    change_class: changeClass,
    runtime_redeployment: units.length > 0,
    affected_units: units.map((unit) => unit.name),
    compatibility: config.release.compatibility,
    artifacts: units.map((unit) => ({
      name: unit.name,
      version: releaseVersion(head),
      kind: unit.kind,
      compatibility: config.release.compatibility,
      archive_paths: unit.archive_paths
    }))
  };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function temporaryDirectory(prefix = "0000-release-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}
