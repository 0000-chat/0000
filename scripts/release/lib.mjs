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

function stripJsoncComments(source) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length) {
        index += 1;
        if (source[index] === "*" && source[index + 1] === "/") {
          result += "  ";
          index += 1;
          break;
        }
        result += source[index] === "\n" || source[index] === "\r" ? source[index] : " ";
      }
      continue;
    }
    result += character;
  }
  return result;
}

function stripJsoncTrailingCommas(source) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    result += character;
  }
  return result;
}

export function readJsonc(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(source)));
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
          ![10, 60].includes(rateLimit.simple.period) ||
          Object.keys(rateLimit).some((key) => !["name", "simple"].includes(key)) ||
          Object.keys(rateLimit.simple).some((key) => !["limit", "period"].includes(key))
        ) {
          throw new Error(`release unit build.runtime.rate_limits are invalid: ${unit.name}`);
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
          (cron) => typeof cron === "string" && /^[0-9*/?,L#-]+(?:\s+[0-9*/?,L#-]+){4}$/.test(cron.trim()),
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
    if (!build.wrangler || typeof build.wrangler !== "object" || Array.isArray(build.wrangler)) {
      throw new Error(`release unit build.wrangler must be an object: ${unit.name}`);
    }
    const allowed = new Set(["durable_objects", "migrations", "d1_databases", "secrets", "observability"]);
    const unsupported = Object.keys(build.wrangler).filter((key) => !allowed.has(key));
    if (unsupported.length > 0) {
      throw new Error(`release unit build.wrangler contains environment-specific keys: ${unit.name}: ${unsupported.join(", ")}`);
    }
    if (build.wrangler.durable_objects !== undefined) {
      const bindings = build.wrangler.durable_objects?.bindings;
      if (
        !build.wrangler.durable_objects ||
        typeof build.wrangler.durable_objects !== "object" ||
        Array.isArray(build.wrangler.durable_objects) ||
        !Array.isArray(bindings) ||
        bindings.length === 0 ||
        !bindings.every(
          (binding) =>
            binding &&
            typeof binding === "object" &&
            !Array.isArray(binding) &&
            typeof binding.name === "string" &&
            NAME_RE.test(binding.name) &&
            typeof binding.class_name === "string" &&
            NAME_RE.test(binding.class_name),
        )
      ) {
        throw new Error(`release unit build.wrangler.durable_objects.bindings is invalid: ${unit.name}`);
      }
    }
    if (build.wrangler.migrations !== undefined) {
      if (
        !Array.isArray(build.wrangler.migrations) ||
        build.wrangler.migrations.length === 0 ||
        !build.wrangler.migrations.every(
          (migration) =>
            migration &&
            typeof migration === "object" &&
            !Array.isArray(migration) &&
            typeof migration.tag === "string" &&
            NAME_RE.test(migration.tag),
        )
      ) {
        throw new Error(`release unit build.wrangler.migrations is invalid: ${unit.name}`);
      }
    }
    if (build.wrangler.d1_databases !== undefined) {
      if (!Array.isArray(build.wrangler.d1_databases) || build.wrangler.d1_databases.length === 0) {
        throw new Error(`release unit build.wrangler.d1_databases must be non-empty: ${unit.name}`);
      }
      for (const database of build.wrangler.d1_databases) {
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
    if (build.wrangler.secrets !== undefined) {
      const required = build.wrangler.secrets?.required;
      if (
        !build.wrangler.secrets ||
        typeof build.wrangler.secrets !== "object" ||
        Array.isArray(build.wrangler.secrets) ||
        !Array.isArray(required) ||
        !required.every((secret) => typeof secret === "string" && NAME_RE.test(secret))
      ) {
        throw new Error(`release unit build.wrangler.secrets.required is invalid: ${unit.name}`);
      }
    }
    if (build.wrangler.observability !== undefined) {
      if (
        !build.wrangler.observability ||
        typeof build.wrangler.observability !== "object" ||
        Array.isArray(build.wrangler.observability) ||
        typeof build.wrangler.observability.enabled !== "boolean"
      ) {
        throw new Error(`release unit build.wrangler.observability is invalid: ${unit.name}`);
      }
    }
  }
  assertWorkerBuildConfigMatchesSource(unit, build);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonValuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normaliseConfigPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const normalised = path.posix.normalize(value);
  if (normalised === "." || normalised.startsWith("/") || normalised === ".." || normalised.startsWith("../")) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }
  return normalised;
}

function sourceRelativePath(build, sourcePath, label) {
  const configDirectory = path.posix.dirname(build.config_path);
  return normaliseConfigPath(path.posix.relative(configDirectory, sourcePath), label);
}

function assertSourceContract(unit, build, label, actual, expected) {
  if (!jsonValuesEqual(actual, expected)) {
    throw new Error(`release unit ${unit.name} ${label} does not match ${build.config_path}`);
  }
}

function normalisedSourceAssets(unit, build, source) {
  const expected = build.assets;
  const actual = source.assets;
  if (expected === undefined && actual === undefined) return undefined;
  if (!expected || !actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`release unit ${unit.name} assets do not match ${build.config_path}`);
  }
  const unsupported = Object.keys(actual).filter(
    (key) => !["binding", "directory", "run_worker_first"].includes(key)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `release unit assets contains unsupported keys for ${unit.name}: ${unsupported.join(", ")}`
    );
  }
  const expectedSourceDirectory = sourceRelativePath(build, expected.source, `${unit.name} assets source`);
  const actualDirectory = normaliseConfigPath(actual.directory, `${unit.name} source assets directory`);
  if (actualDirectory !== expectedSourceDirectory) {
    throw new Error(`release unit ${unit.name} assets directory does not match ${build.config_path}`);
  }
  return {
    binding: actual.binding,
    directory: expected.directory,
    run_worker_first: actual.run_worker_first
  };
}

function normalisedSourceD1Databases(unit, build, source) {
  const expected = build.wrangler?.d1_databases;
  const actual = source.d1_databases;
  if (expected === undefined && actual === undefined) return undefined;
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    throw new Error(`release unit d1_databases does not match ${build.config_path}: ${unit.name}`);
  }
  const expectedSourceDirectory = build.migrations
    ? sourceRelativePath(build, build.migrations.source, `${unit.name} migrations source`)
    : undefined;
  return actual.map((database, index) => {
    const expectedDatabase = expected[index];
    if (!database || typeof database !== "object" || Array.isArray(database)) {
      throw new Error(`release unit d1_databases does not match ${build.config_path}: ${unit.name}`);
    }
    const unsupported = Object.keys(database).filter(
      (key) => !["binding", "database_name", "database_id", "migrations_dir"].includes(key),
    );
    if (unsupported.length > 0) {
      throw new Error(`release unit d1_databases contains unsupported keys for ${unit.name}: ${unsupported.join(", ")}`);
    }
    const sourceDirectory = normaliseConfigPath(
      database.migrations_dir,
      `${unit.name} source d1_databases.migrations_dir`,
    );
    if (expectedSourceDirectory !== undefined && sourceDirectory !== expectedSourceDirectory) {
      throw new Error(`release unit d1_databases migrations_dir does not match ${build.config_path}: ${unit.name}`);
    }
    assertSourceContract(unit, build, "d1_databases", {
      binding: database.binding,
      database_name: database.database_name
    }, {
      binding: expectedDatabase.binding,
      database_name: expectedDatabase.database_name
    });
    return expectedDatabase;
  });
}

function normalisedSourceRateLimits(unit, build, source) {
  const expected = build.runtime?.rate_limits;
  const actual = source.ratelimits;
  if (expected === undefined && actual === undefined) return undefined;
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    throw new Error(`release unit rate_limits do not match ${build.config_path}: ${unit.name}`);
  }
  return actual.map((rateLimit) => {
    if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) {
      throw new Error(`release unit rate_limits do not match ${build.config_path}: ${unit.name}`);
    }
    const unsupported = Object.keys(rateLimit).filter((key) => !["name", "namespace_id", "simple"].includes(key));
    if (unsupported.length > 0) {
      throw new Error(`release unit rate_limits contains unsupported keys for ${unit.name}: ${unsupported.join(", ")}`);
    }
    return { name: rateLimit.name, simple: rateLimit.simple };
  });
}

export function assertWorkerBuildConfigMatchesSource(unit, build, root = repositoryRoot) {
  const sourcePath = path.join(root, build.config_path);
  let source;
  try {
    source = readJsonc(sourcePath);
  } catch (error) {
    throw new Error(`could not read ${unit.name} Wrangler config ${build.config_path}: ${error.message}`);
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`Wrangler config must contain an object: ${unit.name}`);
  }
  assertSourceContract(unit, build, "compatibility_date", source.compatibility_date, build.compatibility_date);
  assertSourceContract(unit, build, "compatibility_flags", source.compatibility_flags, build.compatibility_flags);

  const releaseContract = build.wrangler ?? {};
  const sourceContract = {
    durable_objects: source.durable_objects,
    migrations: source.migrations,
    d1_databases: normalisedSourceD1Databases(unit, build, source),
    secrets: source.secrets,
    observability: source.observability,
    assets: normalisedSourceAssets(unit, build, source),
    rate_limits: normalisedSourceRateLimits(unit, build, source),
    triggers: source.triggers
  };
  const expectedContract = {
    durable_objects: releaseContract.durable_objects,
    migrations: releaseContract.migrations,
    d1_databases: releaseContract.d1_databases,
    secrets: releaseContract.secrets,
    observability: releaseContract.observability,
    assets: build.assets
      ? {
          binding: build.assets.binding,
          directory: build.assets.directory,
          run_worker_first: build.assets.run_worker_first
        }
      : undefined,
    rate_limits: build.runtime?.rate_limits,
    triggers: build.runtime?.triggers
  };
  for (const key of [
    "durable_objects",
    "migrations",
    "d1_databases",
    "secrets",
    "observability",
    "assets",
    "rate_limits",
    "triggers"
  ]) {
    assertSourceContract(unit, build, key, sourceContract[key], expectedContract[key]);
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
    for (const [pathKind, paths] of [["runtime", unit.runtime_paths], ["archive", unit.archive_paths]]) {
      for (const value of paths) {
        const normalised = normalisePath(value.replace(/\*+$/, ""));
        const isReleaseWorkflow = pathKind === "runtime" && normalised === ".github/workflows/release.yml";
        if (!normalised.startsWith("services/") && !isReleaseWorkflow) {
          throw new Error(`release unit path must be under services/ or the public release workflow: ${unit.name}: ${value}`);
        }
        if (normalised.includes("services/cloud") || normalised.includes("/cloud/")) {
          throw new Error(`private Cloud content cannot be a public release unit: ${unit.name}`);
        }
        if (normalised.includes("/cli") || normalised.includes("/sdk")) {
          throw new Error(`SDK and CLI content cannot be a public release unit: ${unit.name}`);
        }
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

const GLOBAL_RUNTIME_INPUTS = new Set(["package.json", "bun.lock", "turbo.json"]);

function additiveUnitRegistrations(config, previousConfig) {
  if (!Array.isArray(previousConfig?.units)) return null;

  const { units: currentUnits, ...currentMetadata } = config;
  const { units: previousUnitsList, ...previousMetadata } = previousConfig;
  if (stableJson(currentMetadata) !== stableJson(previousMetadata)) return null;

  const previousUnits = new Map(previousUnitsList.map((unit) => [unit.name, unit]));
  const currentUnitsByName = new Map(currentUnits.map((unit) => [unit.name, unit]));
  const added = config.units.filter((unit) => !previousUnits.has(unit.name));
  const removed = [...previousUnits.keys()].some((name) => !currentUnitsByName.has(name));
  const changedExisting = [...previousUnits.entries()].some(([name, unit]) => {
    const current = currentUnitsByName.get(name);
    return current && stableJson(current) !== stableJson(unit);
  });

  if (added.length === 0 || removed || changedExisting) return null;
  return added;
}

export function affectedUnits(config, changedFiles, previousConfig = undefined) {
  const files = [...new Set(changedFiles.map(normalisePath))].sort();
  if (files.some((file) => GLOBAL_RUNTIME_INPUTS.has(file))) return [...config.units].sort(byName);

  const releaseUnitsChanged = files.includes("release-units.json");
  const otherFiles = releaseUnitsChanged ? files.filter((file) => file !== "release-units.json") : files;
  const directlyAffected = config.units.filter((unit) => otherFiles.some((file) => unitAffectsFile(unit, file)));

  if (!releaseUnitsChanged) return directlyAffected.sort(byName);

  const addedUnits = additiveUnitRegistrations(config, previousConfig);
  if (!addedUnits) return [...config.units].sort(byName);

  const affectedNames = new Set([...addedUnits, ...directlyAffected].map((unit) => unit.name));
  return config.units.filter((unit) => affectedNames.has(unit.name)).sort(byName);
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

export function makePlan({ config, base, head, changedFiles, previousConfig }) {
  assertReleaseConfig(config);
  const files = [...new Set(changedFiles.map(normalisePath))].sort();
  const units = affectedUnits(config, files, previousConfig);
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
