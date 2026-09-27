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
  if (build.generated_entrypoint !== undefined) {
    if (
      typeof build.generated_entrypoint !== "string" ||
      build.generated_entrypoint.length === 0 ||
      build.generated_entrypoint.includes("/") ||
      normalisePath(build.generated_entrypoint) !== build.generated_entrypoint
    ) {
      throw new Error(`release unit build.generated_entrypoint must be a root-level generated file: ${unit.name}`);
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

  if (build.wrapper !== undefined) {
    if (
      typeof build.wrapper !== "string" ||
      !build.wrapper.startsWith("services/") ||
      normalisePath(build.wrapper) !== build.wrapper
    ) {
      throw new Error(`release unit build.wrapper must be a normalized services path: ${unit.name}`);
    }
  }

  if (build.runtime !== undefined) {
    const runtime = build.runtime;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
      throw new Error(`release unit build.runtime must be an object: ${unit.name}`);
    }
    const unsupported = Object.keys(runtime).filter((key) => !["rate_limits", "triggers"].includes(key));
    if (unsupported.length > 0) {
      throw new Error(`release unit build.runtime has unsupported keys for ${unit.name}: ${unsupported.join(", ")}`);
    }
    if (runtime.rate_limits !== undefined) {
      if (!Array.isArray(runtime.rate_limits) || runtime.rate_limits.length === 0) {
        throw new Error(`release unit build.runtime.rate_limits must be non-empty: ${unit.name}`);
      }
      const names = new Set();
      for (const rateLimit of runtime.rate_limits) {
        if (
          !rateLimit ||
          typeof rateLimit !== "object" ||
          Array.isArray(rateLimit) ||
          typeof rateLimit.name !== "string" ||
          !NAME_RE.test(rateLimit.name) ||
          names.has(rateLimit.name) ||
          !rateLimit.simple ||
          typeof rateLimit.simple !== "object" ||
          Array.isArray(rateLimit.simple) ||
          !Number.isInteger(rateLimit.simple.limit) ||
          rateLimit.simple.limit <= 0 ||
          ![10, 60].includes(rateLimit.simple.period)
        ) {
          throw new Error(`release unit build.runtime.rate_limits are invalid: ${unit.name}`);
        }
        if (Object.keys(rateLimit).some((key) => !["name", "simple"].includes(key))) {
          throw new Error(`release unit build.runtime.rate_limits contain unsupported fields: ${unit.name}`);
        }
        if (Object.keys(rateLimit.simple).some((key) => !["limit", "period"].includes(key))) {
          throw new Error(`release unit build.runtime.rate_limits.simple contains unsupported fields: ${unit.name}`);
        }
        names.add(rateLimit.name);
      }
    }
    if (runtime.triggers !== undefined) {
      if (
        !runtime.triggers ||
        typeof runtime.triggers !== "object" ||
        Array.isArray(runtime.triggers) ||
        !Array.isArray(runtime.triggers.crons) ||
        runtime.triggers.crons.length === 0 ||
        Object.keys(runtime.triggers).some((key) => key !== "crons") ||
        !runtime.triggers.crons.every(
          (cron) =>
            typeof cron === "string" &&
            /^[0-9*/?,L#-]+(?:\s+[0-9*/?,L#-]+){4}$/.test(cron.trim()),
        )
      ) {
        throw new Error(`release unit build.runtime.triggers are invalid: ${unit.name}`);
      }
    }
  }

  for (const [key, label] of [["assets", "assets"], ["migrations", "migrations"]]) {
    const directory = build[key];
    if (directory === undefined) continue;
    if (!directory || typeof directory !== "object" || Array.isArray(directory)) {
      throw new Error(`release unit build.${label} must be an object: ${unit.name}`);
    }
    for (const field of ["source", "directory"]) {
      if (
        typeof directory[field] !== "string" ||
        directory[field].length === 0 ||
        normalisePath(directory[field]) !== directory[field]
      ) {
        throw new Error(`release unit build.${label}.${field} must be a normalized relative path: ${unit.name}`);
      }
    }
    if (!directory.source.startsWith("services/")) {
      throw new Error(`release unit build.${label}.source must be under services/: ${unit.name}`);
    }
    if (key === "assets") {
      if (typeof directory.binding !== "string" || !NAME_RE.test(directory.binding)) {
        throw new Error(`release unit build.assets.binding must be an identifier: ${unit.name}`);
      }
      if (typeof directory.run_worker_first !== "boolean") {
        throw new Error(`release unit build.assets.run_worker_first must be boolean: ${unit.name}`);
      }
    }
  }

  if (build.wrangler !== undefined) {
    const wrangler = build.wrangler;
    if (!wrangler || typeof wrangler !== "object" || Array.isArray(wrangler)) {
      throw new Error(`release unit build.wrangler must be an object: ${unit.name}`);
    }
    const unsupported = Object.keys(wrangler).filter(
      (key) => !["durable_objects", "migrations", "d1_databases", "secrets", "observability"].includes(key),
    );
    if (unsupported.length > 0) {
      throw new Error(`release unit build.wrangler has unsupported keys for ${unit.name}: ${unsupported.join(", ")}`);
    }
    const durableObjects = wrangler.durable_objects;
    if (durableObjects !== undefined) {
      if (!durableObjects || typeof durableObjects !== "object" || Array.isArray(durableObjects)) {
        throw new Error(`release unit build.wrangler.durable_objects must be an object: ${unit.name}`);
      }
      if (!Array.isArray(durableObjects.bindings) || durableObjects.bindings.length === 0) {
        throw new Error(`release unit build.wrangler.durable_objects.bindings must be non-empty: ${unit.name}`);
      }
      for (const binding of durableObjects.bindings) {
        if (
          !binding ||
          typeof binding !== "object" ||
          Array.isArray(binding) ||
          typeof binding.name !== "string" ||
          !NAME_RE.test(binding.name) ||
          typeof binding.class_name !== "string" ||
          !NAME_RE.test(binding.class_name)
        ) {
          throw new Error(`release unit build.wrangler durable object bindings are invalid: ${unit.name}`);
        }
      }
    }
    if (wrangler.migrations !== undefined) {
      if (!Array.isArray(wrangler.migrations) || wrangler.migrations.length === 0) {
        throw new Error(`release unit build.wrangler.migrations must be non-empty: ${unit.name}`);
      }
      const tags = new Set();
      for (const migration of wrangler.migrations) {
        if (
          !migration ||
          typeof migration !== "object" ||
          Array.isArray(migration) ||
          typeof migration.tag !== "string" ||
          !/^v[0-9]+$/.test(migration.tag) ||
          tags.has(migration.tag) ||
          !Array.isArray(migration.new_sqlite_classes) ||
          !migration.new_sqlite_classes.every((name) => typeof name === "string" && NAME_RE.test(name))
        ) {
          throw new Error(`release unit build.wrangler migrations are invalid: ${unit.name}`);
        }
        tags.add(migration.tag);
      }
    }
    if (wrangler.d1_databases !== undefined) {
      if (!Array.isArray(wrangler.d1_databases) || wrangler.d1_databases.length === 0) {
        throw new Error(`release unit build.wrangler.d1_databases must be non-empty: ${unit.name}`);
      }
      for (const database of wrangler.d1_databases) {
        if (
          !database ||
          typeof database !== "object" ||
          Array.isArray(database) ||
          typeof database.binding !== "string" ||
          !NAME_RE.test(database.binding) ||
          typeof database.database_name !== "string" ||
          database.database_name.length === 0 ||
          typeof database.migrations_dir !== "string" ||
          normalisePath(database.migrations_dir) !== database.migrations_dir
        ) {
          throw new Error(`release unit build.wrangler d1_databases are invalid: ${unit.name}`);
        }
      }
    }
    if (wrangler.secrets !== undefined) {
      if (
        !wrangler.secrets ||
        typeof wrangler.secrets !== "object" ||
        Array.isArray(wrangler.secrets) ||
        !Array.isArray(wrangler.secrets.required) ||
        !wrangler.secrets.required.every((name) => typeof name === "string" && NAME_RE.test(name))
      ) {
        throw new Error(`release unit build.wrangler.secrets.required is invalid: ${unit.name}`);
      }
    }
    if (wrangler.observability !== undefined) {
      if (
        !wrangler.observability ||
        typeof wrangler.observability !== "object" ||
        Array.isArray(wrangler.observability) ||
        wrangler.observability.enabled !== true
      ) {
        throw new Error(`release unit build.wrangler.observability must enable observability: ${unit.name}`);
      }
    }
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
