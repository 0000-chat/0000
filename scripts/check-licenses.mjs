// SPDX-License-Identifier: AGPL-3.0-only

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mapRelativePath = "licenses/package-license-map.json";
const mapPath = path.join(root, mapRelativePath);
const errors = [];
const ignoredDirectoryNames = new Set([
  ".git",
  ".turbo",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);

function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isWithin(relative, directory) {
  return relative === directory || relative.startsWith(`${directory}/`);
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..") &&
    !value.split(/[\\/]/u).includes(".") &&
    !value.split(/[\\/]/u).includes("")
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath(filePath)} is not valid JSON: ${error.message}`);
    return null;
  }
}

function walkPackageManifests(directory, manifests) {
  if (!fs.existsSync(directory)) {
    errors.push(`${relativePath(directory)} is missing`);
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectoryNames.has(entry.name)) continue;
      if (relativePath(entryPath) === "services/cloud") continue;
      walkPackageManifests(entryPath, manifests);
    } else if (entry.isFile() && entry.name === "package.json") {
      const manifestPath = relativePath(entryPath);
      manifests.set(path.posix.dirname(manifestPath), {
        manifest: readJson(entryPath),
        manifestPath
      });
    }
  }
}

function readTrackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    errors.push(`unable to enumerate tracked files: ${error.message}`);
    return [];
  }
}

function resolveRepositoryPath(relative) {
  if (!isSafeRelativePath(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function validateLicenseText(policyName, definition) {
  if (!definition || typeof definition !== "object") {
    errors.push(`license policy ${policyName} must be an object`);
    return;
  }

  const textPath = resolveRepositoryPath(definition.text);
  if (!textPath) {
    errors.push(`license policy ${policyName} has an unsafe text path`);
    return;
  }
  if (!fs.existsSync(textPath)) {
    errors.push(`${definition.text} is missing for ${policyName}`);
    return;
  }
  if (typeof definition.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(definition.sha256)) {
    errors.push(`license policy ${policyName} must declare a SHA-256 digest`);
  } else if (hashFile(textPath) !== definition.sha256) {
    errors.push(`${definition.text} does not match its declared SHA-256 digest`);
  }

  const text = fs.readFileSync(textPath, "utf8");
  if (definition.spdx === "AGPL-3.0-only" && !text.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
    errors.push(`${definition.text} is not the GNU Affero GPL v3 text`);
  }
  if (definition.spdx === "Apache-2.0" && !text.includes("Apache License")) {
    errors.push(`${definition.text} is not the Apache License text`);
  }
}

function validateLegacyLicense(entry, packagePath) {
  if (entry.license !== "MIT" || entry.classification !== "legacy-exception") {
    errors.push(`${packagePath} legacy exception must remain classified as MIT/legacy-exception`);
  }
  if (!entry.review || entry.review.status !== "reviewed" || entry.review.decision !== "preserve-without-relicensing") {
    errors.push(`${packagePath} legacy exception must record a reviewed preserve-without-relicensing decision`);
  }
  if (typeof entry.review?.reason !== "string" || entry.review.reason.trim().length === 0) {
    errors.push(`${packagePath} legacy exception must include a nonempty review reason`);
  }

  const textPath = resolveRepositoryPath(entry.licenseText);
  if (!textPath) {
    errors.push(`${packagePath} legacy exception has an unsafe license text path`);
    return;
  }
  if (!fs.existsSync(textPath)) {
    errors.push(`${entry.licenseText} is missing for ${packagePath}`);
    return;
  }
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
    errors.push(`${packagePath} legacy exception must declare a SHA-256 digest`);
  } else if (hashFile(textPath) !== entry.sha256) {
    errors.push(`${entry.licenseText} does not match its declared SHA-256 digest`);
  }
  if (!fs.readFileSync(textPath, "utf8").startsWith("MIT License")) {
    errors.push(`${entry.licenseText} is not the declared MIT license text`);
  }
}

function findNearestPackage(filePath, packageEntries) {
  return packageEntries
    .filter(([packagePath]) => isWithin(filePath, packagePath))
    .sort(([left], [right]) => right.length - left.length)[0];
}

function validateSpdxHeaders(trackedFiles, packageEntries) {
  for (const trackedFile of trackedFiles) {
    if (!isWithin(trackedFile, "packages") && !isWithin(trackedFile, "services")) continue;
    if (trackedFile === "packages/.gitkeep" || trackedFile === "services/.gitkeep") continue;
    if (isWithin(trackedFile, "services/cloud")) continue;

    const nearest = findNearestPackage(trackedFile, packageEntries);
    if (!nearest) continue;
    const [packagePath, entry] = nearest;
    const filePath = path.join(root, trackedFile);
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;

    const identifiers = [...content.matchAll(/SPDX-License-Identifier:\s*([^\r\n*]+)/gu)].map((match) => match[1].trim());
    if (identifiers.length === 0) continue;
    const uniqueIdentifiers = [...new Set(identifiers)];
    if (uniqueIdentifiers.length !== 1 || uniqueIdentifiers[0] !== entry.license) {
      errors.push(`${trackedFile} has SPDX license ${uniqueIdentifiers.join(", ")} but ${packagePath} declares ${entry.license}`);
    }
  }
}

function main() {
  const licenseMap = readJson(mapPath);
  if (!licenseMap) return;

  if (licenseMap.schemaVersion !== 1) {
    errors.push(`${mapRelativePath} must use schemaVersion 1`);
  }
  if (!licenseMap.policy || typeof licenseMap.policy !== "object") {
    errors.push(`${mapRelativePath} must define a policy object`);
  } else {
    validateLicenseText("agpl", licenseMap.policy.agpl);
    validateLicenseText("apache", licenseMap.policy.apache);
  }
  const rootManifest = readJson(path.join(root, "package.json"));
  if (!licenseMap.repository || typeof licenseMap.repository !== "object") {
    errors.push(`${mapRelativePath} must define a repository license entry`);
  } else {
    if (licenseMap.repository.manifest !== "package.json") {
      errors.push(`${mapRelativePath} repository entry must point to package.json`);
    }
    if (licenseMap.repository.name !== rootManifest?.name) {
      errors.push(`repository license entry name disagrees with package.json`);
    }
    if (rootManifest && rootManifest.license !== licenseMap.repository.license) {
      errors.push(`package.json license ${rootManifest.license} disagrees with the repository license map`);
    }
    const repositoryPolicy = Object.values(licenseMap.policy ?? {}).find(
      (definition) => definition?.spdx === licenseMap.repository.license
    );
    if (!repositoryPolicy || repositoryPolicy.classification !== licenseMap.repository.classification) {
      errors.push(`repository license classification is unsupported or inconsistent`);
    }
  }
  if (!licenseMap.packages || typeof licenseMap.packages !== "object" || Array.isArray(licenseMap.packages)) {
    errors.push(`${mapRelativePath} must define packages as an object keyed by package path`);
    return;
  }
  if (!licenseMap.excluded || typeof licenseMap.excluded !== "object" || Array.isArray(licenseMap.excluded)) {
    errors.push(`${mapRelativePath} must define excluded private package paths`);
  }

  const manifests = new Map();
  for (const rootDirectory of ["packages", "services"]) {
    walkPackageManifests(path.join(root, rootDirectory), manifests);
  }

  const packageEntries = Object.entries(licenseMap.packages);
  const policyByLicense = new Map(
    Object.values(licenseMap.policy ?? {})
      .filter((definition) => definition && typeof definition.spdx === "string")
      .map((definition) => [definition.spdx, definition])
  );
  const manifestOwners = new Map();

  for (const [packagePath, entry] of packageEntries) {
    if (!isSafeRelativePath(packagePath) || packagePath.endsWith("/")) {
      errors.push(`license map package path ${packagePath} is unsafe`);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      errors.push(`${packagePath} license map entry must be an object`);
      continue;
    }
    const expectedManifest = `${packagePath}/package.json`;
    if (entry.manifest !== expectedManifest) {
      errors.push(`${packagePath} must point to ${expectedManifest} in the license map`);
    }
    if (!manifests.has(packagePath)) {
      errors.push(`${packagePath} is listed in the license map but has no discovered package manifest`);
      continue;
    }
    if (manifestOwners.has(entry.manifest)) {
      errors.push(`${entry.manifest} is listed more than once in the license map`);
    }
    manifestOwners.set(entry.manifest, packagePath);

    const manifestRecord = manifests.get(packagePath);
    const manifest = manifestRecord.manifest;
    if (!manifest) continue;
    if (manifest.name !== entry.name) {
      errors.push(`${packagePath}/package.json name ${manifest.name} disagrees with the license map name ${entry.name}`);
    }
    if (typeof manifest.license !== "string" || manifest.license.length === 0) {
      errors.push(`${packagePath}/package.json is missing an explicit license`);
    } else if (manifest.license !== entry.license) {
      errors.push(`${packagePath}/package.json license ${manifest.license} disagrees with the license map ${entry.license}`);
    }

    if (entry.classification === "legacy-exception") {
      validateLegacyLicense(entry, packagePath);
    } else {
      const policy = policyByLicense.get(entry.license);
      if (!policy || policy.classification !== entry.classification) {
        errors.push(`${packagePath} has an unsupported or inconsistent license classification`);
      }
    }
  }

  for (const [packagePath, record] of manifests) {
    if (isWithin(packagePath, "services/cloud")) continue;
    if (!licenseMap.packages[packagePath]) {
      errors.push(`${packagePath} is a public package manifest without a license map entry`);
    }
    if (record.manifest && typeof record.manifest.license === "string" && !["AGPL-3.0-only", "Apache-2.0", "MIT"].includes(record.manifest.license)) {
      errors.push(`${packagePath}/package.json uses unsupported license ${record.manifest.license}`);
    }
  }

  for (const [excludedPath, definition] of Object.entries(licenseMap.excluded ?? {})) {
    if (!isSafeRelativePath(excludedPath) || !definition || typeof definition.reason !== "string" || definition.reason.trim().length === 0) {
      errors.push(`excluded license path ${excludedPath} must have a safe path and nonempty reason`);
    }
    if (licenseMap.packages[excludedPath]) {
      errors.push(`${excludedPath} cannot be both excluded and licensed`);
    }
    const excludedManifest = manifests.get(excludedPath);
    if (excludedManifest?.manifest && excludedManifest.manifest.private !== true) {
      errors.push(`${excludedPath}/package.json must remain private while it is excluded from public licensing`);
    }
  }

  const trackedFiles = readTrackedFiles();
  for (const trackedFile of trackedFiles) {
    if (!isWithin(trackedFile, "packages") && !isWithin(trackedFile, "services")) continue;
    if (trackedFile === "packages/.gitkeep" || trackedFile === "services/.gitkeep") continue;
    if (isWithin(trackedFile, "services/cloud")) continue;
    if (!findNearestPackage(trackedFile, packageEntries)) {
      errors.push(`${trackedFile} is under a public package root but has no licensing package boundary`);
    }
  }
  validateSpdxHeaders(trackedFiles, packageEntries);

  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const counts = packageEntries.reduce((result, [, entry]) => {
    result[entry.classification] = (result[entry.classification] ?? 0) + 1;
    return result;
  }, {});
  console.log(
    `license topology check passed (${packageEntries.length} packages: ${counts["agpl-runtime"] ?? 0} AGPL, ${counts["apache-integration"] ?? 0} Apache, ${counts["legacy-exception"] ?? 0} reviewed legacy exception)`
  );
}

main();
