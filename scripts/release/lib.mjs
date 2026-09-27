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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function assertWorkerBuildConfig(unit, build) {
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error(`release unit build configuration must be an object: ${unit.name}`);
  }
  if (build.type !== "cloudflare-worker") {
    throw new Error(`unsupported release build type: ${unit.name}`);
  }
  if (unit.kind !== "cloudflare-worker-bundle") {
    throw new Error(`cloudflare Worker build requires cloudflare-worker-bundle kind: ${unit.name}`);
  }

  const configPath = build.config_path;
  if (typeof configPath !== "string" || !configPath.startsWith("services/")) {
    throw new Error(`release unit build.config_path must be under services/: ${unit.name}`);
  }
  if (normalisePath(configPath) !== configPath) {
    throw new Error(`release unit build.config_path must be normalized: ${unit.name}`);
  }

  for (const key of ["entrypoint", "config"]) {
    const value = build[key];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("/") ||
      normalisePath(value) !== value
    ) {
      throw new Error(`release unit build.${key} must be a root-level artifact file: ${unit.name}`);
    }
  }
  if (!DATE_RE.test(build.compatibility_date)) {
    throw new Error(`release unit build.compatibility_date is invalid: ${unit.name}`);
  }
  if (
    !Array.isArray(build.compatibility_flags) ||
    build.compatibility_flags.length === 0 ||
    !build.compatibility_flags.every((flag) => typeof flag === "string" && NAME_RE.test(flag))
  ) {
    throw new Error(`release unit build.compatibility_flags must be non-empty identifiers: ${unit.name}`);
  }
  if (
    !Array.isArray(build.files) ||
    build.files.length === 0 ||
    new Set(build.files).size !== build.files.length ||
    !build.files.every(
      (file) =>
        typeof file === "string" &&
        !file.includes("/") &&
        normalisePath(file) === file,
    )
  ) {
    throw new Error(`release unit build.files must list root-level artifact files: ${unit.name}`);
  }
  if (!build.files.includes(build.entrypoint) || !build.files.includes(build.config)) {
    throw new Error(`release unit build.files must include entrypoint and config: ${unit.name}`);
  }
  if (!build.files.includes("artifact-manifest.json")) {
    throw new Error(`release unit build.files must include artifact-manifest.json: ${unit.name}`);
  }
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
    if (unit.build !== undefined) assertWorkerBuildConfig(unit, unit.build);
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

const SCAFFOLD_ONLY_SERVICE_ROOTS = [
  "services/platform",
  "services/database",
  "services/brain"
];

const VALIDATION_ONLY_FILE_NAMES = new Set([
  ".env.example",
  ".gitignore",
  ".gitkeep",
  ".nvmrc",
  ".oxlintrc.json",
  "0000-product.json",
  "AGENTS.md",
  "CONTEXT.md",
  "biome.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml"
]);

const VALIDATION_ONLY_DIRECTORY_NAMES = new Set([".githooks", "docs"]);

function pathInside(file, root) {
  return file === root || file.startsWith(`${root}/`);
}

function isValidationOnlyPath(file) {
  if (isDocumentationPath(file)) return true;

  const scaffoldRoot = SCAFFOLD_ONLY_SERVICE_ROOTS.find((root) => pathInside(file, root));
  if (scaffoldRoot) {
    const relative = file.slice(scaffoldRoot.length + 1);
    const segments = relative.split("/");
    const basename = segments.at(-1);
    if (segments.some((segment) => VALIDATION_ONLY_DIRECTORY_NAMES.has(segment))) return true;
    if (segments[0] === ".github" && segments[1] === "workflows" && basename === "quality.yml") return true;
    if (segments[0] === "scripts" && /^(?:check|format(?:-check)?|install-tools|lint)(?:\.[^/]*)?$/.test(basename)) {
      return true;
    }
    if (VALIDATION_ONLY_FILE_NAMES.has(basename)) return true;
    if (/^tsconfig(?:\.[^/]+)?\.json$/.test(basename)) return true;
    return false;
  }

  // `apps/` is not a release unit yet. Keep repository-level markers and
  // documentation harmless, but require every other future app path to opt
  // into an explicit release unit before it can be merged.
  if (pathInside(file, "apps")) {
    const relative = file.slice("apps/".length);
    const segments = relative.split("/");
    const basename = segments.at(-1);
    if (isDocumentationPath(file)) return true;
    if (basename === ".gitkeep" || basename === ".gitignore") return true;
    if (segments.includes("docs")) return true;
    return false;
  }

  return false;
}

export function unmappedRuntimeChanges(changedFiles) {
  const files = [...new Set(changedFiles)].sort();
  return files.filter(
    (file) =>
      (SCAFFOLD_ONLY_SERVICE_ROOTS.some((root) => pathInside(file, root)) || pathInside(file, "apps")) &&
      !isValidationOnlyPath(file),
  );
}

function assertNoUnmappedRuntimeChanges(changedFiles) {
  const unmapped = unmappedRuntimeChanges(changedFiles);
  if (unmapped.length > 0) {
    throw new Error(
      `unmapped runtime changes require an explicit release unit before merge: ${unmapped.join(", ")}`,
    );
  }
}

export function classifyChanges(changedFiles, units) {
  const files = [...new Set(changedFiles)].sort();
  assertNoUnmappedRuntimeChanges(files);
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
